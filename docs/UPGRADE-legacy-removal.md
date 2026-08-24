# Upgrade notes — legacy back-compat removal (feat/invocation)

This branch removed the less-secure, pre-capability paths. The **capability/invocation path** (present a
credential → the Warden verifies it with `verifyProof`) is now the only way to disclose evidence or authorize a
submission. Other apps run a separate version; the in-repo consumers below still reference the removed surface
and must be migrated to the capability path.

## What was removed

- **Legacy evidence path (finding A):** `EvidenceService.handle()` (the requester-supplied `subjectDid` +
  step-up), the `hearthold/evidence-request` handler case, `EvidenceRequest.subjectDid`/`recipientDid`, and the
  `HEARTHOLD_ALLOW_LEGACY_EVIDENCE` gate. Home-plane routes `POST /api/forge` and `POST /api/present` (warden)
  and `POST /api/prove` (emissary) are gone. **Replacement:** `hearthold/invocation` →
  `EvidenceService.handleInvocation` (see `scripts/e2e-invocation-evidence.ts`).
- **Legacy delegation ACL:** `DelegationStore.isAuthorized`/`kindsFor`/`memberFor` and the
  `HEARTHOLD_ALLOW_LEGACY_DELEGATION` fallback. A submission now **requires** a `delegationProof` (a presented
  delegation credential), resolved by `DelegationStore.verifyDelegationPresentation`. **Replacement:** see
  `scripts/e2e-submission.ts` / `scripts/e2e-delegation-presentation.ts`.

**Preserved** (shared infra, not legacy): `SovereignApprover` + `ApprovalRequest/ResponseMessage` (CGPR + Signet),
`verifyEvidenceApproval`, `mintEvidenceGraph`, `DischargeRequester`, pairwise/DTG, `verifyDelegationPresentation`,
`LEGACY_DELEGATION_KINDS`, `DelegationStore.record`/`list` (benign console metadata).

## Consumers to migrate (deferred)

### 1. Submission-feature e2e — add the delegation-presentation preamble
These are **library-level** tests that call `makeWardenHandler` directly and submit without `delegationProof`,
so they compile but fail at runtime: `e2e:triage`, `e2e:ack-before-caption`, `e2e:ingestion-gate`,
`e2e:kind-and-asset`, `e2e:image-witness`, `e2e:mark`.

Fix (mechanical — copy from `scripts/e2e-submission.ts`): after `issueDelegation`, `acceptDelegation(emissary, del)`;
then per submission `const challenge = await requestProof(warden, { schema: delSchema, trustedIssuers: [wardenId.did] }); const delegationProof = await presentProof(emissary, challenge);` and set `submission.delegationProof`.
(They pass `undefined` for the handler's `challenges` arg, so the Warden-minted-challenge gate is skipped — a
self-minted `requestProof` challenge is fine for a direct-library test.)

**Fixed, not deferred:** the **Emissary control daemon** (`emissary/src/control.ts`) and
`e2e:daemon-image-submit` now work end-to-end. The daemon **self-provisions**: it sends the Warden a
`hearthold/challenge-request {purpose:'delegation'}`, the Warden replies with a reusable challenge **and** the
delegation VC(s) it has issued this Emissary, the daemon `acceptCredential`s them and answers with
`createResponse`, and each `/api/submit` attaches that `delegationProof`. No manual preamble; the submission is
now Warden-minted-challenge-bound (audit-3 §1). Construct the Warden handler with a `ChallengeStore` to enable it.

### 2. Emissary app prove button — `apps/emissary/src/api.ts:43`
`post('/api/prove', …)` now 404s. Re-implement on the capability path: the Emissary holds a Sovereign-issued
scope VC, presents it (`requestProof`/`presentProof`), and sends `hearthold/invocation` (see
`scripts/e2e-invocation-evidence.ts`).

### 3. agent-mcp forge tool — `packages/agent-mcp/src/tools.ts:190`
POSTs to the removed `/api/forge`. Re-point to the capability path (issue self-scope VC → present → invoke), or
retire the tool.

### 4. Dead types (harmless; delete when convenient)
`ProveRequest`/`PresentRequest` in `packages/control-types/src/index.ts`; `EvidenceRequest` is now a dead message
type (zero writers) left in the `HearthholdMessage` union as a husk — excise it in a follow-up.

## Verification after migration
`npm run build` clean; `npm run e2e` (delegation + submission) green; the capability suite
(`e2e:invocation-*`, `e2e:delegation-presentation`, `e2e:cgpr`, `e2e:cgpr-ticket-auth`) green; and the
finding-A regression `e2e:invocation-confused-deputy` must stay **ALL ATTACKS REFUSED**.
