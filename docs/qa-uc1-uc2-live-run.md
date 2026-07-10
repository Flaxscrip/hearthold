# Hearthold control-plane — end-to-end endpoint QA

The Hearthold-side live check for the two joint flows (labelled **UC1 / UC2** in the shared plan). This
tests the **Warden control endpoints** end-to-end in plain Hearthold terms; it is **curl-drivable
today**, no client UI required. The game-layer live-run (a card-game front-end with its own vocabulary
and rendering) lives on that project's side — keep its terminology there; this doc stays neutral.

> **Scope.** Runs against the **personal Warden** (`~/.hearthold`) — the Sovereign's own 7th Capital —
> **not** the shared KB Warden (`~/.hearthold-kb`). Keep them separate (Invariant I).

**Endpoints exercised** — `POST /api/card/face` (render an artefact's face) · `GET`/`POST
/api/triage[/confirm]` (quarantine queue) · `POST /api/marks/{claimable,claim}` (Warden-issued Mark
credentials) · `POST /api/recall` (private RAG) · `POST /api/forge` (mint an attestation) ·
`POST /api/present` (present + single-use spend). SSE on `/api/events`: `triage-confirmed`,
`mark-issued`, `scroll-forged`, `scroll-burned`.

**Ports** — Warden control `4310` · Sovereign (Signet) control `4311` · Signet Approver app `5174`.

---

## Part A — Identities & prereqs (once)

```bash
cd ~/hearthold && git pull && npm run build
export HEARTHOLD_DATA_ROOT=~/.hearthold            # the PERSONAL vault (not the KB root)
export HEARTHOLD_NODE_URL=http://flaxlap.local:4222
export HEARTHOLD_OLLAMA_URL=http://megaflax.local:11434
```

- [ ] **A1** `curl -s $HEARTHOLD_NODE_URL/api/v1/capabilities` → node up; `curl -s $HEARTHOLD_OLLAMA_URL/api/tags` shows the embedding + chat models.
- [ ] **A2** Provision three identities (each its own passphrase): `warden init`, `witness init`, `sovereign init`. **Note all three `did:cid`.**
- [ ] **A3** Delegate the Witness so it can submit to the vault: `warden delegate <witnessDid>` → prints a credential DID → `HEARTHOLD_PASSPHRASE=<witness> witness accept <credentialDid>`.

## Part B — Launch the stack (one process per identity)

- [ ] **B1** Warden (vault + all control endpoints): `warden control 4310`.
- [ ] **B2** Signet (step-up approvals): `HEARTHOLD_SIGNET_PIN=<pin> sovereign control 4311` + `cd apps/signet-approver && npm run dev` (`localhost:5174`).
- [ ] **B3** Sanity: `ps … | grep dist/index.js` shows exactly **warden control** and **sovereign control** — one per identity (don't also run `warden serve` / `witness control`).

## Part C — Seed the inputs (via the Witness CLI)

`export HEARTHOLD_WARDEN_DID=<wardenDid>` first.

- [ ] **C1 — documents (UC2):** submit several `document` observations:
  ```bash
  for d in "Dune — Frank Herbert" "Snow Crash — Neal Stephenson" "The Sovereign Individual" \
           "Neuromancer — William Gibson" "Cryptonomicon — Neal Stephenson"; do
    HEARTHOLD_PASSPHRASE=<witness> witness submit document "Reference: $d"
  done
  ```
- [ ] **C2 — locations (UC1):** submit a day of `location` observations, incl. a lunch:
  ```bash
  HEARTHOLD_PASSPHRASE=<witness> witness submit location "09:10 — arrived at the office"
  HEARTHOLD_PASSPHRASE=<witness> witness submit location "12:45 — had lunch at Chez Nous on Rue Vivienne"
  HEARTHOLD_PASSPHRASE=<witness> witness submit location "18:30 — gym, then home"
  ```
- [ ] **C3** Each `submit` returns a receipt with an assigned sensitivity. Quarantine-classified items land needing confirmation → they appear in triage.

---

## Part D — UC2: capture → triage/confirm → count threshold → Mark issuance

- [ ] **D1** `GET /api/triage` lists the quarantined documents (awaiting confirmation).
- [ ] **D2** `POST /api/triage/confirm { artefactId, sensitivity }` for each (batch) → the flag clears, the sensitivity is set, `triage-confirmed` fires. *(Confirming is the human gesture that permits setting the sensitivity, including relaxing below the threshold.)*
- [ ] **D3** `POST /api/marks/claimable` with a candidate (e.g. `{ markName, spec:{ kind:"document" }, threshold: 5 }`) → returns the current count and `claimable` once the count ≥ threshold. *(Use a small threshold for a QA run — the Warden re-counts.)*
- [ ] **D4** `POST /api/marks/claim { candidate, subjectDid:<sovereignDid> }` → the **Warden re-counts** and issues the Mark credential; `mark-issued` fires. Returns the `credentialDid`.
- [ ] **D5** Verify: the issued credential resolves on-node, is the expected Mark type, and carries **no `axes`** claim (axes-free until the axes pact lands).

**✔ UC2 exit:** documents captured → confirmed at triage → count reaches threshold → **Mark credential, Warden-issued and verifiable.**

## Part E — UC1: capture → recall → forge → present → single-use spend

- [ ] **E1 — recall:** `POST /api/recall { query:"Where did I have lunch yesterday?" }` → a `machine-derived` answer naming **Chez Nous**, with citations. Nothing leaves the device.
- [ ] **E2 — forge:** `POST /api/forge` with a `ProveRequest` (`{ claim, kind:"location", from, to }` derived from the recall) → mints an ephemeral, single-use **attestation**. Location is **LOW/witnessed** → clears at **STANDING, no step-up**. *(If your classifier marked it MEDIUM+, the **Signet pops** an evidence-approval — approve it in the Approver app.)* Returns a `ProofRecord` with `credentialDid`, `trustClass`, `validUntil`; `scroll-forged` fires.
- [ ] **E3 — present (first):** `POST /api/present { credentialDid }` → **`verified: true`**.
- [ ] **E4 — present (replay):** same request again → **`verified: false`, reason "already spent (burned)"**; `scroll-burned` fires. Single-use is enforced verifier-side (the holder can't reset it).

**✔ UC1 exit:** day of locations → lunch recall with citations → forged attestation → presented once → **refused on replay.**

## Part F — Guardrail spot-checks (Hearthold endpoint behaviour)

- [ ] **F-a** `POST /api/card/face` on a SEALED artefact at a low tier → **`granted:false`** (a refusal, not the content and not an error). Raise the tier → it hydrates. *(This is the release ladder — SEALED needs MULTIFACTOR.)*
- [ ] **F-b** No plaintext at rest: a hydrated face is unsealed transiently for the response only; nothing writes a face to disk outside the vault, and there is no face cache.
- [ ] **F-c** Every Mark issued is **axes-free** (no `axes` claim anywhere).

*(Client-side rendering guardrails — how a refused face or an unconfirmed artefact is displayed — are the front-end's concern and live on that project's side.)*

## Teardown

- [ ] Clear the run's vault artefacts for a fresh pass (a scratch `HEARTHOLD_DATA_ROOT`, or a personal-vault reset). Keep identities.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/card/face` returns nothing useful | Warden control not on 4310, or wrong `artefactId` | Confirm `warden control 4310`; check the artefact exists (`warden vault`) |
| `submit` rejected "no valid delegation" | Witness not delegated/accepted | Redo A3 (`warden delegate` → `witness accept`) |
| `/api/forge` hangs on a MEDIUM+ claim | Signet not reachable for the step-up | Run B2; or keep UC1 data LOW |
| `/api/recall` says "Nothing has been indexed yet" | No matching artefacts, or the embed model missing | Redo C2; `curl $OLLAMA_URL/api/tags` shows the embedding model |
| Mark won't claim | Count below threshold (Warden re-counts) | Submit more documents, or lower the candidate threshold |
| Second `/api/present` still verifies | (should not happen) | Capture it — single-use regression |

## Sign-off

| | Pass | Notes |
|---|---|---|
| A–C setup + seed | ☐ | |
| **UC2** — triage/confirm → count threshold → Mark issued, verifiable | ☐ | |
| **UC1** — recall → forge → present → refused on replay | ☐ | |
| F guardrail spot-checks (face refusal / no plaintext at rest / axes-free) | ☐ | |

**Exit:** ☐ both flows exercised end-to-end against the live control plane.
