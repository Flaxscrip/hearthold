# Security audit — L1 (key custody) + L2 (disclosure) findings

Adversarial sweep (2026-07-27) of the two Hearthold-owned layers, verified against file:line. Status tracked
here as fixes land. Companion to [`SECURITY-AUDIT-PLAN.md`](SECURITY-AUDIT-PLAN.md). Mesh is excluded — it has
its own B1–B6 ladder under `e2e:pvm-boundaries`.

## L2 — disclosure

| # | Finding | Sev | Status |
|---|---|---|---|
| L2-1/2 | **Recall (personal + KB) skipped the sensitivity ladder** — `rankByQuery`'s ceiling defaulted to `Infinity` and no production caller set `maxSensitivity`; a bare STANDING session (and the public KB portal) could retrieve + summarize SEALED content with no step-up. | **HIGH** | **FIXED** (`e2e:recall-ceiling`) |
| L2-6 | `POST /api/delegate`, `/api/kb/grant`, `/api/kb/revoke`, `/api/kb/policy` call neither `effectiveViewer` nor a step-up — so they're reachable unauthenticated *even on a require-session node* (that gate only fires through `effectiveViewer`). `/api/delegate` mints an Emissary delegation for any body-supplied DID. | **HIGH** | **FIXED** (`e2e:route-gating`) |
| L2-3 | `snapshot.delegations` is not owner-scoped (`control.ts` ~211) — `vault` is filtered by `visibleTo`, `delegations` returns every member's Emissary relationships. Cross-member metadata leak. | **HIGH** | **FIXED** (`e2e:l2-hardening`) |
| L2-4 | `POST /api/triage/confirm` downgrades sensitivity (incl. SEALED→PUBLIC) from a **client-supplied** value with only an ownership check — no Signet step-up, unlike every comparable write. | MED-HIGH | **FIXED** (`e2e:l2-hardening`) |
| L2-5 | Guardian-read scope/ceiling refusal echoes the artefact's real `kind`/`sensitivity` in the reason (`ruleset.ts` ~348, surfaced at `/api/guardian/read`) — a governor can enumerate attributes beyond their ceiling (G-grade existence leak). | MED | **FIXED** (`e2e:l2-hardening`) |
| L2-7 | `ingestCredentialToPartition` defaults unclassified → `MEDIUM`, contradicting `DEFAULT_SENSITIVITY=SEALED`. Dormant (unwired) but a landmine. | MED | **FIXED** (`e2e:l2-hardening`) |
| L2-8 | `marks` counting pools the whole vault (no `visibleTo`) — a household-wide count-by-kind leaks to any member. | LOW | **FIXED** (`e2e:l2-hardening`) |

## L1 — identity & key custody

| # | Finding | Sev | Status |
|---|---|---|---|
| L1-1 | One `HEARTHOLD_PASSPHRASE` decrypts all four agents' wallets — a single leak collapses PVM separation. (Mitigated in a real deployment by device separation; a co-located-dev hardening.) Fix: per-role `HEARTHOLD_PASSPHRASE_<ROLE>` with fallback. | MED | **FIXED** (`e2e:l1-custody`) |
| L1-2 | Warden control daemon opens its wallet once (no reload-before-write) while mutating routes sign/save — a concurrent `warden` CLI write can be silently clobbered (non-atomic `saveWallet`). Sovereign uses `openKeymasterFresh`; Warden doesn't. | MED | **FIXED** (`e2e:l1-custody`) |
| L1-4 | No agent CLI exposes `rotateKeys`/`changePassphrase` — no built-in incident-response path for a compromised key/passphrase. | MED | **FIXED** (`e2e:l1-custody`) |
| L1-5 | `SessionKeyStore.zeroize` is best-effort (JS strings immutable) — hold key material in `Buffer`s for a real wipe. | LOW | **FIXED** (`e2e:l1-custody`) |
| L1-7 | Browser SSE uses bare `EventSource` (can't send `X-Hearthold-Session`), so owner-scoped *private* frames never reach a Table — fails **closed** (broken feature, not a leak); the naive fix (token in query) would leak the token. Design deliberately. | LOW | NOTE (Sevenfold) |

### Confirmed solid (verified, not asserted)
- Browser apps are **keyless** (zero `@didcid/*` deps; no wallet/sign/cipher in `apps/*`). Signet only ever emits a response DID; `login/sign` hard-checks challenge purpose. `wallet.json` encrypted at rest; passphrase never logged/echoed.
- `decideRelease`/`CLEARANCE` is a clean ordinal gate; where invoked (`face.ts`, `evidence.ts`, `cgpr.ts`) the tier is server-computed from a real step-up, never client-asserted. Attenuation + selective-disclosure are verifier-enforced. Mesh B1–B6 are adversarially tested.

## Fix log

- **L1 custody (L1-1/2/4) — FIXED** (`e2e:l1-custody`: 34/34, pure precedence + source-scan wiring +
  live rotate/passphrase/reload against the node):
  - **L1-1** (per-role passphrase): core `passphraseFor(role)` reads `HEARTHOLD_PASSPHRASE_<ROLE>` first, else
    the shared `HEARTHOLD_PASSPHRASE`, else throws (fail-closed). All five agents (warden/sovereign/emissary/
    verifier/registry) now resolve through it — a leak of one role's passphrase no longer decrypts every
    wallet, so device separation isn't the *only* thing holding PVM apart. Single shared value still works for
    dev; documented in `.env.example`.
  - **L1-2** (reload-before-write): extracted `reloadWallet(handle)` (the reload core) from
    `openKeymasterFresh` and gave the Warden control daemon a `withWalletWrite()` guard that (1) **serializes**
    wallet mutations so two requests can't race, and (2) reloads the wallet from disk (torn-read retry,
    fail-closed) immediately before each write. Every wallet mutation in the daemon — `issueDelegation`,
    `claimMark`, evidence `forge`, KB `grant`/`revoke` (+ partition provision) — is wrapped, so a concurrent
    `warden` CLI write is no longer clobbered by the daemon's stale cache. Strictly stronger than the
    Sovereign's per-request reopen (that mints a fresh handle but doesn't serialize); reuses the shared handle
    so no service reconstruction.
  - **L1-4** (rotation CLI): core `runKeyMaintenance(handle, op, newPass?)` (reloads first, then rotate /
    changePassphrase / checkWallet). Every agent exposes `rotate` + `passphrase <new>` + `check`
    (`wallet-check` on the registry, whose `check` is its trust-authorization command). A passphrase change
    re-encrypts the wallet **at rest** — proven live: the new passphrase opens it, the old is refused.
  - **L1-5** (real key wipe): `SessionKeyStore` now holds each read-guest key's secret `d` scalar in a
    `Buffer` (public JWK fields kept plain), so `zeroize` overwrites the key bytes **in place** (`fill(0)`)
    rather than de-referencing an immutable string that lingered until GC. The JWK is reassembled only
    transiently for a single decrypt. Proven behaviourally: the e2e reaches the actual held Buffer, confirms
    it carries the secret, then confirms `zeroize` turns those exact bytes all-zero — and the real rewrap →
    decrypt → zeroize round-trip (`e2e:partition-rewrap`) still passes. Residual (documented): a JWK string a
    caller already materialized and any crypto-lib private copy live until GC — the ceiling in a GC'd runtime.
  - Only L1-7 remains (SSE `EventSource` can't send the session header — fails *closed*), a deliberate NOTE
    for Sevenfold, not an exposure.

- **L2-1/2 — FIXED.** `clearanceCeiling(tier)` (security.ts) maps a tier to its max sensitivity. Personal
  recall (`control.ts`) derives the ceiling from the viewer's achieved tier — default STANDING→LOW, MEDIUM+
  runs the same Signet step-up as a MEDIUM+ card-face (`recallCeiling`). KB recall (`kb.ts`) ceilings from the
  space's read assurance (factor1→MEDIUM, factor2→SEALED) so SEALED never surfaces to a public-portal/factor1
  reader. `RecallRequest.maxSensitivity` added. `e2e:recall-ceiling` (10/10): default draws on ≤LOW; a SEALED
  note, even maximally similar, is dropped until the tier clears it. **Behaviour change for clients:** recall
  now defaults to ≤LOW — the Table must request `maxSensitivity` and handle the step-up for MEDIUM+ (same as
  it already does for card-face reveals).

- **L2 disclosure cleanup (L2-3/4/5/7/8) — FIXED** (one batch, `e2e:l2-hardening` 13/13 source-scan +
  `e2e:mark` live):
  - **L2-3** (owner-scope delegations): a `DelegationRecord` already carried `memberDid`; `list()` now
    surfaces it, the delegate route attributes the delegation to the delegator (`actor`), and `snapshot`
    filters via `delegationsFor(viewer)` — same `owner ?? sovereign` rule as `ownerOf` for artefacts. A
    member no longer sees another member's Emissary relationships.
  - **L2-4** (co-sign a declassification): `triage/confirm` now requires the owner's Signet co-sign when the
    confirmed sensitivity is **lower** than the artefact's current one (relaxing SEALED costs what SEALED
    costs). Design call: a downgrade is a disclosure-authorizing act, so it routes through the same
    `coSign()` as every comparable write — and this is what makes `confirmedBySovereign` a real
    proof-of-human, not just a control-plane call. Raising/keeping is fail-safe → no step-up.
  - **L2-5** (uniform guardian refusal): `authorizeGuardianRead` tags a scope/ceiling denial `code:'scope'`
    and no longer echoes the artefact's real kind/sensitivity; `guardianRead` collapses a `scope` denial to
    the same `'not available'` as a non-existent/not-the-subject's artefact (G-grade obsidian). `no-edge`/
    `expired` (about the governor's OWN edge, no artefact leak) still surface as-is.
  - **L2-7** (fail-safe ingest): `ingestCredentialToPartition` defaults unclassified content to
    `DEFAULT_SENSITIVITY` (SEALED), not `MEDIUM` — consistent with the classifier's fail-safe.
  - **L2-8** (owner-scope marks): `countFor` filters to the claimant's visible set (`owner ?? sovereign`, or
    `shared`), `claimMark` re-counts over the claimant only, and `POST /api/marks/claimable` is now
    session-gated (was reachable unauthenticated). A Mark can't be earned off — or leak the count of —
    another member's data. **Behaviour change for clients:** `marks/claimable` now requires a session.

- **L2-6 — FIXED.** `delegate`, `kb/grant`, `kb/revoke`, `kb/policy` now go through `effectiveViewer(ctx)` —
  so `require-session` gates them (401 unauthenticated) and the acting principal is known. The
  authority-granting / membership-changing ones (`delegate`, `kb/grant`, `kb/revoke`) require a Signet
  co-sign via `coSign()` (the delegator for a delegation, the KB governor — or the owner of a self-governed
  KB — for a grant/revoke), matching the `household/admit` + `card/pass` pattern; `kb/policy` keeps its
  governor ruleset-signer as the human gate. `e2e:route-gating` (10/10) asserts each route is wired to the
  gate so it can't silently regress. **Behaviour change for clients:** these four now require a session, and
  delegate/grant/revoke now prompt a Signet co-sign — the Table must handle the step-up (same as card/pass).
