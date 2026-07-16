# Hearthold — multi-Sovereign "family" model (session-aware control plane + household)

## Context

Sevenfold's Table drives the Warden's localhost control API (`:4310`). Today that API is
**single-Sovereign**: every route acts as `config.sovereignDid`, with no per-caller identity — so the
Table can't "act as member X," and `kb-spaces.md`'s load-bearing rule (*"the visible set is derived
server-side from the authenticated session DID"*) can't be honored there. This blocks the whole **P1.5
family model**.

The decided direction (flaxscrip + Fable): the **full household shared∪private** model, governed by a
**Master-Sovereign**, with the shared side on **Archon Vaults** (read-only Vault-member = native
governance tier), preserving **PVM separation** (the custodian holds data, the governor authorizes
rules, each member's own Signet approves their own step-ups — no party reconstructs the whole).

**Master-Sovereign is a governance ROLE, not a new agent** — it is the space `governorDid`, realized on
existing primitives (signed Ruleset chain + Signet approval + `governorDid` semantics). It owns the
shared Archon Vault and signs the membership Trust Registry / contribution tiers; the Warden executes
and custodies.

Outcome: a member logs into the Table (proven identity), and every surface — cards, faces, recall,
triage, marks, forge, the SSE stream — is scoped server-side to that member's visible set, with a
Vault-backed shared household pool and Master-Sovereign-governed membership.

## Model (what's reused vs. new)

- **Shared partition = an Archon Vault**, Warden-owned (custody stays with the custodian). New wrapper
  `packages/warden/src/household-vault.ts` over `keymaster.createVault/addVaultMember/removeVaultMember/
  addVaultItem/getVaultItem/listVaultMembers/testVault`. Vault **membership = read** (decrypt) access =
  the native "read-only member"; **owner writes** (`checkVaultOwner` is private in keymaster, so only the
  Warden admits/writes). Created with `{ registry: config.registry }` (local in dev — hygiene).
- **Private partitions = existing per-member KB partitions, reused unchanged**: `provisionMemberPartition`
  (`kb-config.ts:51`), `PartitionStore`/`partitionIdFor` (`partition-store.ts:13`), `KbService.ownPartition`
  (`kb.ts:226`). Isolation already proven by `e2e-kb-spaces.ts`.
- **Personal vault gets two additive fields**, not a partition rewrite: `Artefact.owner?` + `scope?:'shared'|'private'`
  (`store.ts:7`). Visible set = a filter: `scope==='shared' || owner===sessionDid`. (Recommendation from
  design: do NOT force the local single-Warden vault through the KB group-per-partition indirection — it
  exists only for Phase-2 remote federation the local vault doesn't need.)
- **Household config** (new, sibling to `KbConfigStore`): `{ householdId, sharedVaultDid, governorDid,
  policyAsset, readGroup, writeGroup, memberPartitions:true }`.
- **Read-only vs contributor tier**: Vault membership alone = read-only; "contributor" = a governed write
  tier the Master-Sovereign sets in the signed Ruleset `capabilities`. `share-to-household` checks it.

## Session-aware control plane

- **`ControlSessionStore`** (new `packages/warden/src/control-session.ts`) modeled on `KbService.sessions`
  (`kb.ts:138,214`): `Map<token,{did,exp}>`, `issue(did)` (randomBytes(24), `config.sessionTtlMs`),
  `resolve(token)`.
- **Login routes** (in `control.ts`), reusing `keymaster.createChallenge`/`verifyResponse` exactly like
  `KbService.startLogin`/`completeLogin` (`kb.ts:179-211`): `POST /api/login/start` → challenge DID;
  `POST /api/login/complete {response}` → verify → mint token. (Proven identity only — Fable amendment 1;
  no client-asserted DID.)
- **Token transport**: header `X-Hearthold-Session`, read off `ctx.req.headers` (already passed —
  `control-server.ts:20`; no framework change). Add it to CORS Allow-Headers (`control-server.ts:49`).
- **`requireSession(ctx)`** helper resolves `sessionDid` (throws → `{ok:false}` 400) at the top of every
  scoped route; the visible set is computed from `sessionDid` **server-side** (the G-grade boundary,
  never from request content).
- **Expose identity**: `GET /api/whoami`; add `WardenStatus.sessionDid` (`control-types:59`) so the Table
  drops the `VITE_SOVEREIGN_DID` hack.

## Per-route changes (exact seams)

- `snapshot` (`control.ts:148`), `recall` (`control.ts:184`), `triage` (`control.ts:260`),
  `marks/claimable` (`control.ts:270`): filter to the session member's visible set (shared-Vault items if
  `testVault(sharedVaultDid, sessionDid)` ∪ their private partition ∪ owned/shared personal-vault items).
- `marks/claim` (`control.ts:278`): `subjectDid = sessionDid` (subsumes the old `?? config.sovereignDid`
  one-liner).
- `forge` (`control.ts:204,208`): subject + prover = `sessionDid`.
- **`card/face` — SECURITY FIX** (`control.ts:251` / `face.ts`): today it trusts the **client-claimed
  `tier`** with no step-up. New: refuse if `owner!==sessionDid && scope!=='shared'` (cross-member face →
  `granted:false`, obsidian); never trust a client tier — start at STANDING and, for `sensitivity>=MEDIUM`,
  run a **real** step-up against the **session member's own** Signet (`makeDidcommActionApprover`,
  `kb.ts:109`), feeding the achieved tier into `decideRelease` (`face.ts:47`).
- **SSE session-filtering** (`control-server.ts:44,130`): `sse` set becomes `{res,did}`; `emit(type,data,
  audience?)` delivers a frame iff broadcast, or `audience.scope==='shared'`, or `client.did===audience.owner`,
  or `client.did===governor`. `submission-stored` (`control.ts:360`) etc. pass `{owner,scope}` (Fable
  amendment 3 — activity metadata is a disclosure).

## Per-member Signet + configurable timeout (Fable amendment 2 + the 180s note)

- Thread `subjectDid` (already computed at `evidence.ts:92`) into `SovereignApprover.requestApproval` and
  use it as the `transport.request` target instead of `config.sovereignDid` (`control.ts:118`). Every
  step-up then routes to the subject member's own device. (`card/face` already uses the per-member
  `makeDidcommActionApprover`.)
- `config.stepUpTimeoutMs` (env `HEARTHOLD_STEPUP_TIMEOUT_MS`, documented hard cap) replaces the literal
  `180_000` (`control.ts:118`) and the `170_000` defaults (`kb.ts:86,109`).

## Governance flows (PVM-preserving; Master-Sovereign via Signet)

- **Admit/remove member**: require the Master-Sovereign's **signed authorization first** — recommended as
  an appended signed Ruleset (`setKbAssurance`-style, `kb-config.ts:123`, via `makeDidcommRulesetSigner`
  to `governorDid`) so "the Master-Sovereign signs the membership registry" is literally true and
  auditable. On authorization the Warden executes `addVaultMember` (shared read) + `grantAuthorization`
  (KB private roster) + `provisionMemberPartition` (their private partition). Remove = governor-authorized
  `removeVaultMember` + `revokeAuthorization`; private content retained under the member's own ownership.
- **Share-to-household** (`POST /api/vault/share {artefactId}`): only the **owner** may share their own
  item; check the member's **contributor tier** (read-only refused); if factor2, run the session member's
  own step-up; Warden executes `addVaultItem` and indexes it `scope:'shared'`.

## Phasing (landable; dependencies noted)

- **Phase 0 — types + config** (no behavior change): `VaultItem.scope`, `RecallCitationView.scope`,
  `WardenStatus.sessionDid`; `Artefact.owner/scope`; `IndexEntry.owner/scope` + an owner/scope filter in
  `rankByQuery` (mirroring the existing `kb` filter); `config.stepUpTimeoutMs`. **Unblocks Sevenfold now**
  (they build the scope token + citation badges, lock Table-side isolation vs a mock two-session source).
- **Phase 1 — data model**: attribute `owner` on submit (`service.ts:53`) from the Emissary→member
  delegation (extend `DelegationStore` to carry the delegating member); backfill existing → `owner=config.
  sovereignDid, scope='private'` (Fable 4); new `household-vault.ts` + household config store.
- **Phase 2 — session**: `ControlSessionStore`, login routes, `whoami`, session header + CORS,
  `WardenStatus.sessionDid`; **per-member approver refactor + configurable timeout** (Phase 3's face/forge
  scoping depends on the approver being session-targeted).
- **Phase 3 — scoping (G-grade)**: per-route visible sets + card/face fix + SSE filtering. Unblocks the
  two-member family isolation smoke. **Depends on 1+2** (do not ship the face fix before the per-member
  approver, or MEDIUM+ faces still route to `config.sovereignDid`).
- **Phase 4 — governance**: admit/remove + share under Master-Sovereign Signet.
- **Phase 5 — polish**: contributor-tier surfaced in `KbView`/console; remote private-partition federation
  left at the existing `PartitionLocation:'remote'` seam (out of scope).

**Recommended first delivery**: Phase 0 immediately (zero behavior change, unblocks Sevenfold), then 1→3
(the family isolation smoke), then 4. Land per-phase against the Sevenfold dev instance
(`~/.hearthold-sevenfold`, `HEARTHOLD_REGISTRY=local`).

## Files to modify (by phase)

- **P0**: `packages/control-types/src/index.ts`; `packages/warden/src/store.ts`; `packages/core/src/recall.ts`;
  `packages/core/src/config.ts`.
- **P1**: `packages/warden/src/{service.ts,delegations.ts,kb-config.ts}`; new `household-vault.ts`; a
  backfill helper (new `migrate-owner.ts` or a `warden` CLI subcommand).
- **P2**: new `packages/warden/src/control-session.ts`; `control.ts` (login/whoami/status/`requireSession`);
  `packages/core/src/control-server.ts` (CORS); `evidence.ts` + `control.ts:114-127` (per-member approver);
  `config.ts` + `kb.ts:86,109` (timeout).
- **P3**: `control.ts` (snapshot/recall/triage/marks/forge), `face.ts`, `triage.ts`, `marks.ts`,
  `recall.ts` (filter); `control-server.ts` (SSE `{res,did}` + `emit` audience).
- **P4**: `control.ts` (admit/remove/share), `household-vault.ts`, `kb-config.ts` (roster ruleset +
  contributor tier).

## Verification (e2e, live against the Archon node; `HEARTHOLD_REGISTRY=local`)

- `scripts/e2e-family-session.ts` — two members `createResponse` to control-plane challenges → tokens;
  assert snapshot/card-face/recall/triage return only that member's visible set; forged/expired/cross-member
  token refused (mirror `e2e-kb-login.ts`).
- `scripts/e2e-household-vault.ts` — `createVault`; governor-authorized `addVaultMember`; `addVaultItem`
  under contributor tier; a member reads shared ∪ own-private but never another's private (mirror
  `e2e-kb-spaces.ts`); a read-only member is refused share; `removeVaultMember` drops shared read.
- `scripts/e2e-household-governance.ts` — admit/remove/share refused without the Master-Sovereign's Signet
  authorization (like `GovernanceDeclined`), succeed with it.
- **Live two-member run against `:4310`** — boot `warden control`, log in two members via their Signets,
  assert over real HTTP + SSE that no cross-member card/face renders and no cross-member `submission-stored`
  event leaks (validates the SSE filter end-to-end).

## Registry hygiene (invariant)

Every new DID this introduces — control-plane login challenges, the household Archon Vault, member
partitions — must be created on `registry: config.registry` (= `local` in dev). Never default to
hyperswarm. `self-test`/e2e assert `registration.registry==='local'` (as the harness path already does).

---

## Review — Fable, 2026-07-16: APPROVED with two additions and one decision for the Sovereign

All four prior amendments landed correctly (proven identity, per-member Signets incl. the P3→P2 dependency
catch, SSE audience filtering, owner/backfill). The `card/face` client-trusted-tier finding is a genuine
pre-existing vulnerability correctly reclassified as a security fix — do not let it wait for the family
feature; it ships with Phase 2/3 regardless. Phasing, reuse-over-rebuild (Vault as native read tier;
private partitions unchanged; no KB indirection for the local vault), and the e2e suite are all right.

**Addition 1 — session lifecycle ends.** Add `POST /api/logout`; make expiry absolute (not sliding);
tokens never logged; and **membership removal MUST invalidate the removed member's live sessions**
(wire session revocation into the remove flow, e2e-asserted: removed member's token refused immediately,
not at TTL).

**Addition 2 — share-to-household step-up scales with item sensitivity.** Sharing is a disclosure to N
household members: run the release ladder for the item's sensitivity with the household as audience
(owner's own Signet), on top of the contributor-tier check. A SEALED item shared to the household should
cost what SEALED costs.

**DECIDED (flaxscrip, 2026-07-16) — governor observation & guardianship:**

- `governorObservesActivity` (SSE metadata): household-config policy bit, **default FALSE**. Privacy-first
  households and non-family deployments get isolation by default. Drop the implicit
  `client.did===governor` branch from the SSE filter; deliver governor frames only when this bit is true.
- **Guardianship (governor access to member DATA) is supported but is NOT a boolean.** Implement as
  **Guardianship Rulesets** — reusing the shipped Ruleset machinery, per-member:
  - One Ruleset per governor↔member edge: `actor: <governorDid>`, subject-member named, standard
    `capabilities { kinds, ceiling }` scoping (e.g. parent: `location` ≤ MEDIUM; employer: `document`
    work-kinds only). Total access expressible, never implicit.
  - **Signatures:** governor signs (Signet); the member **acknowledges** — adult members co-sign
    (disclosed-monitoring consent, employment-law-shaped); for minors the guardian signs on their behalf.
  - **Visible to the watched, always:** the member's surfaces (Table/portal) MUST render active
    guardianship conspicuously (the stable-DID-exception "padlock" pattern). No covert mode exists in
    this codebase, by decision.
  - **Access-receipted:** every guardian read of member data emits a transaction record visible to the
    member (evidence discipline, pointed inward).
  - **Expiring/reviewable:** `validUntil` + supersession; emancipation/offboarding = one signed
    supersession. Guardian reads route through `decideRelease()` with the guardianship Ruleset as the
    authorization source — the ladder is not bypassed, it is *satisfied by law*.
  - Phasing: guardianship lands **after** Phase 4 (it builds on admit/governance flows) — Phase 5 scope,
    e2e mirroring `e2e-household-governance.ts` (unacknowledged-adult guardianship refused; receipts
    delivered; expiry enforced; member surface shows the edge).
  - Sevenfold note: guardianship rendering is a new conspicuous UI state for the Table (P1.5+), spec'd
    with the `scope` token work.
