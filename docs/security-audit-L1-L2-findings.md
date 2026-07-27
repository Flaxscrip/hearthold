# Security audit — L1 (key custody) + L2 (disclosure) findings

Adversarial sweep (2026-07-27) of the two Hearthold-owned layers, verified against file:line. Status tracked
here as fixes land. Companion to [`SECURITY-AUDIT-PLAN.md`](SECURITY-AUDIT-PLAN.md). Mesh is excluded — it has
its own B1–B6 ladder under `e2e:pvm-boundaries`.

## L2 — disclosure

| # | Finding | Sev | Status |
|---|---|---|---|
| L2-1/2 | **Recall (personal + KB) skipped the sensitivity ladder** — `rankByQuery`'s ceiling defaulted to `Infinity` and no production caller set `maxSensitivity`; a bare STANDING session (and the public KB portal) could retrieve + summarize SEALED content with no step-up. | **HIGH** | **FIXED** (`e2e:recall-ceiling`) |
| L2-6 | `POST /api/delegate`, `/api/kb/grant`, `/api/kb/revoke`, `/api/kb/policy` call neither `effectiveViewer` nor a step-up — so they're reachable unauthenticated *even on a require-session node* (that gate only fires through `effectiveViewer`). `/api/delegate` mints an Emissary delegation for any body-supplied DID. | **HIGH** | OPEN |
| L2-3 | `snapshot.delegations` is not owner-scoped (`control.ts` ~211) — `vault` is filtered by `visibleTo`, `delegations` returns every member's Emissary relationships. Cross-member metadata leak. | **HIGH** | OPEN |
| L2-4 | `POST /api/triage/confirm` downgrades sensitivity (incl. SEALED→PUBLIC) from a **client-supplied** value with only an ownership check — no Signet step-up, unlike every comparable write. | MED-HIGH | OPEN (needs a tier design call) |
| L2-5 | Guardian-read scope/ceiling refusal echoes the artefact's real `kind`/`sensitivity` in the reason (`ruleset.ts` ~348, surfaced at `/api/guardian/read`) — a governor can enumerate attributes beyond their ceiling (G-grade existence leak). | MED | OPEN |
| L2-7 | `ingestCredentialToPartition` defaults unclassified → `MEDIUM`, contradicting `DEFAULT_SENSITIVITY=SEALED`. Dormant (unwired) but a landmine. | MED | OPEN |
| L2-8 | `marks` counting pools the whole vault (no `visibleTo`) — a household-wide count-by-kind leaks to any member. | LOW | OPEN |

## L1 — identity & key custody

| # | Finding | Sev | Status |
|---|---|---|---|
| L1-1 | One `HEARTHOLD_PASSPHRASE` decrypts all four agents' wallets — a single leak collapses PVM separation. (Mitigated in a real deployment by device separation; a co-located-dev hardening.) Fix: per-role `HEARTHOLD_PASSPHRASE_<ROLE>` with fallback. | MED | OPEN |
| L1-2 | Warden control daemon opens its wallet once (no reload-before-write) while mutating routes sign/save — a concurrent `warden` CLI write can be silently clobbered (non-atomic `saveWallet`). Sovereign uses `openKeymasterFresh`; Warden doesn't. | MED | OPEN |
| L1-4 | No agent CLI exposes `rotateKeys`/`changePassphrase` — no built-in incident-response path for a compromised key/passphrase. | MED | OPEN |
| L1-5 | `SessionKeyStore.zeroize` is best-effort (JS strings immutable) — hold key material in `Buffer`s for a real wipe. | LOW | OPEN |
| L1-7 | Browser SSE uses bare `EventSource` (can't send `X-Hearthold-Session`), so owner-scoped *private* frames never reach a Table — fails **closed** (broken feature, not a leak); the naive fix (token in query) would leak the token. Design deliberately. | LOW | NOTE (Sevenfold) |

### Confirmed solid (verified, not asserted)
- Browser apps are **keyless** (zero `@didcid/*` deps; no wallet/sign/cipher in `apps/*`). Signet only ever emits a response DID; `login/sign` hard-checks challenge purpose. `wallet.json` encrypted at rest; passphrase never logged/echoed.
- `decideRelease`/`CLEARANCE` is a clean ordinal gate; where invoked (`face.ts`, `evidence.ts`, `cgpr.ts`) the tier is server-computed from a real step-up, never client-asserted. Attenuation + selective-disclosure are verifier-enforced. Mesh B1–B6 are adversarially tested.

## Fix log

- **L2-1/2 — FIXED.** `clearanceCeiling(tier)` (security.ts) maps a tier to its max sensitivity. Personal
  recall (`control.ts`) derives the ceiling from the viewer's achieved tier — default STANDING→LOW, MEDIUM+
  runs the same Signet step-up as a MEDIUM+ card-face (`recallCeiling`). KB recall (`kb.ts`) ceilings from the
  space's read assurance (factor1→MEDIUM, factor2→SEALED) so SEALED never surfaces to a public-portal/factor1
  reader. `RecallRequest.maxSensitivity` added. `e2e:recall-ceiling` (10/10): default draws on ≤LOW; a SEALED
  note, even maximally similar, is dropped until the tier clears it. **Behaviour change for clients:** recall
  now defaults to ≤LOW — the Table must request `maxSensitivity` and handle the step-up for MEDIUM+ (same as
  it already does for card-face reveals).
