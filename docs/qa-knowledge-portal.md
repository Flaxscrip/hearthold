# Knowledge Portal — "with user" QA checklist

A hands-on script for testing the full Knowledge Portal on the **flaxlap dev box** before the
archon.social deploy. Two roles: **Operator** (runs the stack, manages access) and **Member** (a
first-time user who signs in with their own wallet). Work top to bottom; check each box; note anything
that surprises you in the margin.

**What you need**
- flaxlap: `~/hearthold` on `main`, `npm run build` clean.
- Ollama reachable with the two models (embeddings + a chat model), e.g. on megaflax.
- The Archon node up (`curl http://flaxlap.local:4222/api/v1/capabilities`).
- A **Member wallet** on a phone/browser (the react-native wallet, or `wallet.archon.technology`) that
  can scan a QR / open a `?challenge=` deep link.

**Ports used here** — Warden control `4310` · Sovereign(Signet) control `4311` · Emissary `kb-web` `4313`
· apps: warden-console `5173`, signet-approver `5174`, kb-portal `5176`.

---

## Part A — Operator: stand up the KB (once)

Use a **dedicated KB data root**, not your personal `~/.hearthold`.

```bash
cd ~/hearthold && git pull && npm run build
export HEARTHOLD_DATA_ROOT=~/.hearthold-kb
export HEARTHOLD_NODE_URL=http://flaxlap.local:4222
export HEARTHOLD_OLLAMA_URL=http://megaflax.local:11434     # wherever Ollama lives
export HEARTHOLD_PASSPHRASE=<kb-warden-pass>
```

- [ ] **A1** `warden kb-init hearthold-kb` → prints read/write groups, policy, "self-governed". **Note the Warden `did:cid`** (also `warden status`).
- [ ] **A2** `warden kb-seed --kb hearthold-kb` → "Loaded 8 demo card(s) …". *(Seeds shared-knowledge FAQ.)*
- [ ] **A3** *(optional, tests the step-up later)* `warden kb-policy write factor2 --kb hearthold-kb`. Leave reads at factor1.
- [ ] **A4** `warden kb-status` → shows `hearthold-kb`, 0 members, the assurance tiers.

**Expected:** no errors; the KB exists and is seeded. *(To wipe and retry: `warden kb-reset --kb hearthold-kb`.)*

---

## Part B — Operator: launch the stack

Four processes (separate terminals). The Warden control daemon serves the KB **and** backs the console.

- [ ] **B1** Warden (KB brain + console API): `warden control 4310` → "serving N Knowledge Base(s): hearthold-kb".
- [ ] **B2** Emissary (public web bridge): `HEARTHOLD_WARDEN_DID=<wardenDid> emissary kb-web 4313` → "KB Portal … relaying to Warden …". *(Set `HEARTHOLD_PORTAL_PUBLIC_URL=http://<flaxlap-reachable-host>:4313` if the Member's wallet is on another device — the login callback is baked into the challenge and the wallet must reach it.)*
- [ ] **B3** Portal (the Member's page): `cd apps/kb-portal && VITE_PORTAL_URL=http://localhost:4313 VITE_KB_ID=hearthold-kb npm run dev` → opens `http://localhost:5176`.
- [ ] **B4** Warden Console (Operator's admin): `cd apps/warden-console && npm run dev` → `http://localhost:5173`; the **Knowledge Bases** panel shows `hearthold-kb`.

**Watch the Emissary + Warden terminals during login** — a healthy login prints `[kb-web] login/start → relaying…` then `[kb] login-start received → challenge issued` then `[kb-web] login/start ✓ challenge received`.

---

## Part C — Member: first visit (happy path)

The Member opens `http://localhost:5176` (or the reachable host).

- [ ] **C1** The page shows a **QR code**, an **"Open in Signet"** button, and **"Copy challenge DID"** — with a live "waiting for your wallet…" pulse. *(If it says "preparing…" forever, see Troubleshooting.)*
- [ ] **C2** Member **scans / opens / pastes** the challenge into their Archon wallet and approves. Within a couple of seconds the portal flips to **"Signed in as did:cid:…"**. *(Keys never left the wallet.)*
- [ ] **C3** Member reads their **DID** off the screen and gives it to the Operator.
- [ ] **C4** Member goes to **Ask**, asks *"What is the 7th Capital?"* → **refused / not authorized** (they aren't a member yet). This is correct.

## Part D — Operator: authorize the Member (Console)

- [ ] **D1** In the Warden Console (`5173`) → the `hearthold-kb` card → paste the Member's DID into **Grant access** → pick **both** → **Grant**. The DID appears under read/write.
  *(CLI equivalent: `warden kb-grant <memberDid> both --kb hearthold-kb`.)*

## Part E — Member: query & contribute

- [ ] **E1** Member re-runs **Ask** *"What is the 7th Capital?"* → a grounded answer from the seeded set, **with citations**. *(Machine-derived; query not logged.)*
- [ ] **E2** Ask *"What is a Warden?"* and *"When did the Knowledge Portal first run?"* → sensible seeded answers.
- [ ] **E3** Member goes to **Contribute**, adds a fact (e.g. kind `event`: *"Our guild meets Thursdays at 8pm."*).
  - If **write = factor1**: it saves immediately ("✓ contributed").
  - If **write = factor2** (A3): the Member's **Signet pops** an "authorize: write on hearthold-kb" prompt — see Part G.
- [ ] **E4** Member asks *"When does the guild meet?"* → answers from their own contribution.

**Expected:** the Member only ever proved DID control; no keys, no passwords in the browser.

## Part F — Operator: revoke (Console)

- [ ] **F1** In the Console, **revoke** the Member (read) on `hearthold-kb`.
- [ ] **F2** Member re-runs **Ask** → **refused**. Revocation is one gesture; access is gone.
- [ ] **F3** Re-grant to continue.

## Part G — *(optional)* factor-2 write step-up

Requires the Member to run a **Signet** that answers approval requests (the Signet Approver app).

- [ ] **G1** Member: `HEARTHOLD_SIGNET_PIN=<pin> sovereign control 4311` + `cd apps/signet-approver && npm run dev` (`http://localhost:5174`), signed in as their wallet.
- [ ] **G2** With `write=factor2`, Member **Contributes** on the portal → the Signet Approver shows an amber **"action authorization"** card (write on hearthold-kb + the Warden-authored detail).
- [ ] **G3** Member approves with the **PIN** → the contribution saves. Deny → it's refused. *(The Emissary is never on this approval channel.)*

## Part H — Reset for the next run

- [ ] **H1** `warden kb-reset --kb hearthold-kb` → "removed N artefact(s)…". Identity, groups, policy kept.
- [ ] **H2** *(optional)* `warden kb-seed --kb hearthold-kb` to reload the demo for the next tester.

---

## Negative / edge cases (worth one pass each)

- [ ] **N1 Unauthorized query** — a signed-in but un-granted DID: Ask is refused (Part C4). ✔ authN ≠ authZ.
- [ ] **N2 Wrong KB** — with a second KB provisioned (`warden kb-init other-kb`, seed it), confirm a query on `hearthold-kb` **never** surfaces `other-kb` content (per-KB scoping). Portals are separate by `VITE_KB_ID`.
- [ ] **N3 Two members** — grant a second DID; both query the same KB; each sees the same shared answers. Multi-Sovereign = just another grant.
- [ ] **N4 Stale sign-in** — leave the QR untouched several minutes, then respond: the portal should surface an expired-login message (refresh to retry), not hang.
- [ ] **N5 Reload reliability** — refresh the portal several times rapidly; every load should render a QR first try (the transport concurrency fix). No "preparing…" that never resolves.

---

## Troubleshooting (symptom → cause → fix)

| Symptom | Likely cause | Fix |
|---|---|---|
| Portal stuck on **"preparing…"**, then *"timed out waiting for reply to kb-login-start"* | The Emissary's `HEARTHOLD_WARDEN_DID` ≠ the running KB Warden's DID, or the Warden isn't serving | Compare `warden status` DID to the Emissary's env; ensure `warden control`/`serve` is up for `~/.hearthold-kb`. Watch for `[kb] login-start received` on the Warden — if it never prints, the message isn't reaching that Warden |
| QR renders but sign-in never completes | The Member's wallet can't reach the **callback** (`…/api/kb/login/callback`) | Set `HEARTHOLD_PORTAL_PUBLIC_URL` on `kb-web` to a host the wallet can reach; keep `VITE_PORTAL_URL` the same origin |
| Ask returns *"not authorized"* after granting | Granted the **wrong DID** (e.g. the Emissary's, or a different wallet than the one that signed in) | Grant the exact DID the portal showed after sign-in; `warden kb-status` lists members |
| Ask returns *"Nothing has been indexed yet."* | KB not seeded, or the embedding model missing | `warden kb-seed --kb …`; `curl $OLLAMA_URL/api/tags` shows the embedding + chat models |
| Recall answers are slow | The chat model is heavy on this hardware | Expected on CPU; use a smaller/faster chat model via `HEARTHOLD_CLASSIFIER_MODEL` |
| A `hearthold-kb` query surfaces another KB's fact | (should not happen — fixed) | If seen, capture it — it's a scoping regression |

## Sign-off

| Section | Pass | Notes |
|---|---|---|
| A/B setup + launch | ☐ | |
| C–E first-visit + query + contribute | ☐ | |
| F revoke | ☐ | |
| G factor-2 step-up (optional) | ☐ | |
| H reset | ☐ | |
| N1–N5 edge cases | ☐ | |

**Overall:** ☐ ready for archon.social  ·  ☐ needs fixes (list them)
