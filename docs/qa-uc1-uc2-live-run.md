# Sevenfold UC1 / UC2 — live-run checklist

The end-to-end script for the P1 exit: **UC2** (shelf scan → triage reveal → Library deck → Librarian
Mark) and **UC1** (a day of locations → lunch Divination → forge a scroll → present once → it burns),
played on real hardware. Companion to `qa-knowledge-portal.md`.

**Two roles:** **Operator** (runs the daemons, seeds inputs) and **Player** (the Sovereign, at the
Table with their wallet/Signet). For a solo run one person does both.

> **Scope note.** This Table runs against the **personal Warden** (`~/.hearthold`) — the Sovereign's own
> 7th Capital — **not** the shared KB Warden (`~/.hearthold-kb`). Keep them separate (Invariant I).
> This checklist assumes **`apps/table` is built** and consuming the Warden control API; the
> hearthold-side endpoints it uses are all shipped and tested (face-hydration, triage, marks, recall,
> forge, present).

**Ports** — Warden control `4310` · Sovereign(Signet) control `4311` · Signet Approver app `5174` ·
Table app (sevenfold) `apps/table`.

**What each endpoint backs:** cards → `POST /api/card/face` · triage → `GET/POST /api/triage[/confirm]` ·
marks → `POST /api/marks/{claimable,claim}` · Divination → `POST /api/recall` · forge →
`POST /api/forge` · present → `POST /api/present`. SSE on `/api/events`: `triage-confirmed`,
`mark-issued`, `scroll-forged`, `scroll-burned`.

---

## Part A — Identities & prereqs (once)

```bash
cd ~/hearthold && git pull && npm run build
export HEARTHOLD_DATA_ROOT=~/.hearthold           # the PERSONAL vault (not the KB root)
export HEARTHOLD_NODE_URL=http://flaxlap.local:4222
export HEARTHOLD_OLLAMA_URL=http://megaflax.local:11434
```

- [ ] **A1** `curl -s $HEARTHOLD_NODE_URL/api/v1/capabilities` → node up; `curl -s $HEARTHOLD_OLLAMA_URL/api/tags` shows the embedding + chat models.
- [ ] **A2** Provision the three identities (each its own passphrase): `warden init`, `witness init`, `sovereign init`. **Note all three `did:cid`.**
- [ ] **A3** Delegate the Witness so it can submit to the vault:
  `warden delegate <witnessDid>` → prints a credential DID → `HEARTHOLD_PASSPHRASE=<witness> witness accept <credentialDid>`.
- [ ] **A4** *(optional, UC2 visual)* If you want book cards to read **uncommon** (not just count toward the Mark), run the shelf-photo enrichment so `classificationTags` are non-empty. Without it the Mark still issues (count-based); only the veracity border differs. *(Enrichment job is a separate hearthold-side script — flag if not yet present.)*

## Part B — Launch the stack (one process per identity)

- [ ] **B1** Warden (vault + all Table endpoints): `warden control 4310` → "Warden control on … console API live".
- [ ] **B2** Signet (step-up + Table-vault signing): `HEARTHOLD_SIGNET_PIN=<pin> sovereign control 4311`, and `cd apps/signet-approver && npm run dev` (`localhost:5174`).
- [ ] **B3** The Table: `cd apps/table && npm run dev` (points `VITE_CONTROL_URL` at `http://127.0.0.1:4310`).
- [ ] **B4** Sanity: `ps … | grep dist/index.js` shows exactly **warden control**, **sovereign control** — one per identity (don't also run `warden serve` / `witness control`).

## Part C — Seed the UC inputs (Operator, via the Witness CLI)

`export HEARTHOLD_WARDEN_DID=<wardenDid>` first.

- [ ] **C1 — UC2 books:** submit several shelf-photo **documents** (text stand-ins are fine in P1):
  ```bash
  for b in "Dune — Frank Herbert" "Snow Crash — Neal Stephenson" "The Sovereign Individual" \
           "Neuromancer — William Gibson" "Cryptonomicon — Neal Stephenson"; do
    HEARTHOLD_PASSPHRASE=<witness> witness submit document "Shelf photo: $b"
  done
  ```
- [ ] **C2 — UC1 locations:** submit a day of **location** observations, including a lunch:
  ```bash
  HEARTHOLD_PASSPHRASE=<witness> witness submit location "09:10 — arrived at the office"
  HEARTHOLD_PASSPHRASE=<witness> witness submit location "12:45 — had lunch at Chez Nous on Rue Vivienne"
  HEARTHOLD_PASSPHRASE=<witness> witness submit location "18:30 — gym, then home"
  ```
- [ ] **C3** Each `submit` prints a receipt with an assigned sensitivity. *(Quarantine-classified items land needing confirmation → they'll appear in triage.)*

---

## Part D — UC2 live: shelf → triage → Library deck → Librarian Mark

- [ ] **D1** In the Table, the new book documents appear as **born-obsidian** cards (per G1: only the seal — **no border, no pips**).
- [ ] **D2** Open triage; the cards are in the confirmation queue (`GET /api/triage`). **Batch-confirm** them at an appropriate sensitivity → each card **flips/reveals** (the booster-pack moment), and `triage-confirmed` fires. *(Confirming is the human gesture that permits setting sensitivity, incl. relaxing below the threshold.)*
- [ ] **D3** The **Library deck** (a saved `EvidenceClaimSpec` for `kind: document`) meter climbs as cards reveal — count, % enriched, mythic count.
- [ ] **D4** When the deck crosses the Mark threshold, the Table shows **"Librarian I — claimable"** (`POST /api/marks/claimable`). *(For a demo, set the candidate threshold small, e.g. 5, not 25.)*
- [ ] **D5** Click **claim** → the **Warden re-counts** (never trusts the Table's number) and issues an **axes-free SevenfoldMark** (`POST /api/marks/claim`); `mark-issued` fires. The Mark card appears.
- [ ] **D6** Verify: the issued credential resolves on-node, is a `SevenfoldMark` named "Librarian I", and carries **no `axes`** claim.

**✔ UC2 exit:** shelf scan → triage reveal → Library deck ≥ threshold → **Librarian Mark, Warden-issued and verifiable.**

## Part E — UC1 live: locations → Divination → Forge → Burn

- [ ] **E1 — Divination:** ask *"Where did I have lunch yesterday?"* (`POST /api/recall`). A **draft card** renders: **dashed frame, citations listed, `machine-derived` label, NO seal** — and it never left the house. Answer names **Chez Nous**.
- [ ] **E2 — Forge:** forge the draft (`POST /api/forge`, its citations → the claim + `kind: location` + window). Because location is **LOW/witnessed**, it clears at **STANDING — no step-up**. *(If your classifier marked it MEDIUM+, the **Signet pops** an evidence-approval — approve it in the Approver app.)* A **scroll card** appears: trust class, evidence summary, `validUntil`, and the **burn banner**; `scroll-forged` fires.
- [ ] **E3 — Present (first):** play the scroll (`POST /api/present`) → **`verified: true`**.
- [ ] **E4 — Present (replay):** play it again → **`verified: false`, reason "already spent (burned)"**; `scroll-burned` fires and the scroll card visibly **burns out** (grays to a spent scroll in the deck's history).

**✔ UC1 exit:** day of locations → lunch Divination with citations → forged scroll → presented once → **burns on replay.**

## Part F — Table state (persistence, decisions #2/#8)

- [ ] **F1** Arrange cards/decks on the Table; **explicit "save Table"** gesture → snapshot to the **Archon Vault** (session-end snapshot only — no gesture logging). *(Signed with the Sovereign's own handle — B2.)*
- [ ] **F2** Reload the Table (or open on a "second device" = a second handle) → the arrangement restores. **Refs only** — no card faces are stored in the Table vault (G2).

## Part G — Guardrail spot-checks

- [ ] **G-a (G1)** A SEALED / unconfirmed card shows **only the seal** — never a veracity border, royal marker, or axes pips. (Route rendering through `displayVeracity`, never `veracityOf` directly.)
- [ ] **G-b (G2)** Nothing writes a card **face** to disk outside the vault; the Table holds no face cache — faces come only from `/api/card/face` at render time.
- [ ] **G-c** A refused face hydration renders **obsidian**, not an error.
- [ ] **G-d** Everything stays **axes-free** (no `axes` on any Mark/classification — the PrivacyMage pact is still pending).

## Teardown

- [ ] Clear the run's vault artefacts for a fresh pass (a personal-vault reset, or a scratch `HEARTHOLD_DATA_ROOT`). Keep identities.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Cards never render faces | Warden control not on 4310, or Table's `VITE_CONTROL_URL` wrong | Confirm `warden control 4310` is up; point the Table at it |
| `submit` rejected "no valid delegation" | Witness not delegated/accepted | Redo A3 (`warden delegate` → `witness accept`) |
| Forge hangs / times out on a MEDIUM+ claim | Signet not reachable for the step-up | Run B2 (`sovereign control 4311` + Approver); or keep UC1 data LOW |
| Divination says "Nothing has been indexed yet" | No location artefacts, or the embed model missing | Redo C2; `curl $OLLAMA_URL/api/tags` shows the embedding model |
| Mark won't claim | Deck count below threshold (Warden re-counts) | Submit more documents, or lower the candidate threshold for the demo |
| Book cards read `common`, not `uncommon` | Enrichment not run (no `classificationTags`) | Optional A4 job, or set tags at triage confirm; the Mark still issues |
| Second present still verifies | (should not happen) | Capture it — single-use regression |

## Sign-off

| | Pass | Notes |
|---|---|---|
| A–C setup + seed | ☐ | |
| **UC2** — triage reveal → Library deck → Librarian Mark, verifiable | ☐ | |
| **UC1** — Divination → forge → present → **burns on replay** | ☐ | |
| F Table-state snapshot round-trip | ☐ | |
| G guardrail spot-checks (G1/G2/obsidian/axes-free) | ☐ | |

**P1 exit:** ☐ UC1 + UC2 both played end-to-end on real hardware.
