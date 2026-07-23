# Bitstring Status List Revocation — Results

Replaces the recognitionId-list revocation with a **W3C Bitstring Status List**, closing the volume leak
named in the old revocation findings: the previous list held opaque recognitionIds, so its **length was the
revocation count**. Now revocation is a fixed-size bitstring — each recognition carries a random index, a set
bit means revoked, and verifiers fetch the whole list (herd privacy). Run **live** against Archon
(`@didcid/keymaster` 0.6.0 → `flaxlap.local:4222`, `registry=local`).

- Module: [`packages/core/src/status-list.ts`](../../packages/core/src/status-list.ts) (+ `MeshWarden.admit` wired to it)
- Blocker smoke (Task 1): [`scripts/smoke-status-list.ts`](../../scripts/smoke-status-list.ts)
- Test matrix: [`scripts/e2e-status-list.ts`](../../scripts/e2e-status-list.ts) — `npm run e2e:status-list`

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass' HEARTHOLD_REGISTRY=local \
       HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_DATA_ROOT="$(mktemp -d)"
npm run smoke:status-list   # Task 1 blocker check
npm run e2e:status-list      # the full matrix
```

No dual path: the recognitionId list is deleted, not kept alongside.

## The model

Credits the **W3C Bitstring Status List** (Verifiable Credentials Bitstring Status List) the way the
disclosure work credits RFC 9901 — we adopt its shape. Archon stays dumb: it stores, versions, and
controller-checks an **opaque signed blob** (the encoded bitstring); it never understands "revocation." Same
version-pinning discipline as everywhere else (record BOTH `versionSequence` and the content-addressed
`versionId`; assert they match on resolve). Fail-CLOSED wherever the status fact is unavailable.

- **List as an Archon asset.** The Sovereign owns a `StatusList` (its own `did:cid`), `addProof`-signed,
  whose `encodedList` is a **GZIP-compressed, base64** bitstring of the **W3C minimum 131,072 bits** — the
  minimum exists to provide herd privacy, so it is not shrunk.
- **Random, durable, collision-free index per recognition.** `issueRecognition` allocates a **random**
  `statusListIndex` through a durable, sealed **AllocationRecord** (see below) — never sequential (that would
  leak issuance order/time) and never colliding (which would silently cross-revoke). It records the
  `statusListCredential` DID in the credential.
- **Revoke by recognitionId.** `publishRevocation(recognitionId)` resolves the index through the record,
  flips the bit, and updates the asset (new version). The caller tracks no indices. Idempotent.
- **AllocationRecord — a second, SEALED asset.** The Sovereign owns a record (recognitionId → index) sealed
  to its own key (`sealForWarden` to its own DID). Only the Sovereign reads it; a verifier fetching the
  public bitstring never sees it, so herd privacy is unaffected. Allocation is optimistic + version-pinned
  (read at N, re-check the head is N before writing, retry on conflict); exhaustion is a clear error, never a
  reuse. Full matrix: [`scripts/e2e-allocation.ts`](../../scripts/e2e-allocation.ts) — `npm run e2e:allocation`.
- **Check at admission, FAIL-CLOSED.** `admit` reads the recognition's bit through a `StatusListResolver`
  (max-age cache, version pin). It first checks the recognition points at the list this node checks, then
  reads the bit; unresolvable / unsigned / wrong-issuer / stale-and-unrefreshable → **DENY**.
- **Audit binding.** The signed `MeshAnswer` carries `statusCheckedAt` + `statusListVersion` (the pinned
  `{versionSequence, versionId}`); `auditRevocationAt` resolves that exact version and reads the bit to
  settle "was it revoked at answer time".

## Test matrix — every case the expected verdict (live)

A correct REJECT is a PASS; the checker was never loosened.

| Case | Expected | Result (real output) |
|---|---|---|
| HAPPY | ACCEPT | answer pins the StatusList version + `statusCheckedAt`; index e.g. `72064 / 131072` |
| REVOKED-BIT | REJECT | `recognition has been revoked (status bit set)` (check `revocation`); setting the bit twice is idempotent |
| PERSISTENCE | REJECT | a **fresh Warden with no in-memory state** reads the published bit and rejects |
| FAIL-CLOSED | REJECT | `revocation status unavailable — deny (fail-closed): … status list unresolvable: Invalid DID` |
| AUDIT-REPLAY | settled | pinned version reads bit 0 + `versionId` matches; current reads 1; pinned historical still reads 0 |
| CONTROLLER-TAMPER | REJECT | Archon refuses a non-Sovereign `mergeData`; the set bit is unchanged |
| INDEX-RANDOMNESS | not sequential | 8 issued indices distinct, spread ~104,028 across 131,072 — not a consecutive run |
| HERD-SIZE | fixed length | bitstring is the fixed 131,072-bit (16,384-byte) minimum, unchanged as more bits are set |

### INDEX-RANDOMNESS — the privacy property, tested

Eight consecutive issuances produced indices spread across ~104k of the 131,072-bit space, all distinct and
**not a consecutive run**. Sequential indices would have leaked issuance order and timing — re-introducing
the very correlation the bitstring exists to prevent — so random assignment is asserted, not assumed.

### HERD-SIZE — the volume-leak fix, tested

The published bitstring decodes to the fixed **131,072-bit / 16,384-byte** length regardless of how many
bits are set, and stays that length after further revocations. The list's *shape* no longer encodes the
revocation count the way a UUID list's length did. (What still leaks a little: compressed *size* — see
FINDINGS.md, stated plainly.)

### AUDIT-REPLAY — disputes are settleable

The HAPPY answer pinned `{versionSequence, versionId}` of the StatusList at check time. Verified end to end:
resolving that **exact pinned version** reads the recognition's bit as **0** and its `versionId` matches the
answer. After a later revocation, the **current** version reads the bit as **1** while the **pinned
historical version still reads 0** (immutable, content-addressed history). "Answered under a revoked
recognition" is falsifiable.

## Durable allocation matrix (`npm run e2e:allocation`) — every case the expected verdict (live)

The sealed AllocationRecord closes the birthday-collision correctness bound (see FINDINGS). A correct
error is a PASS.

| Case | Result |
|---|---|
| NO-COLLISION | 120 indices in a 150-slot space (random would ~certainly collide) → **all distinct** |
| RESTART-SAFETY | a **fresh issuer** with no in-memory state allocates 10 more → collides with none of the earlier batch |
| CONCURRENCY | a forced version conflict → the racing allocation **retries** (attempts > 1); both end distinct, neither overwrites |
| SEALED | a third party resolving the record **cannot decrypt** it; no recognitionId/index in its cleartext |
| REVOKE-BY-ID | `publishRevocation(recognitionId)` sets the bit at the index the record holds |
| EXHAUSTION | a full 4-slot space throws `status list exhausted …` — a clear error, **never a silent reuse** |
| INDEX-RANDOMNESS | 8 full-space allocations span ~90k of 131,072, distinct, non-sequential |

## Task 1 (blocker) — the ~16KB payload works

Grounded live before building: a **~50%-dense** bitstring (the worst case for gzip) is a **21.4 KB** base64
payload (~16 KB compressed); `createAsset` stores it, repeated `mergeData` updates mint clean versions, and
`resolveDID({versionSequence})` returns the pinned historical bitstring with a matching `versionId`. A
non-Sovereign update is refused. No size blocker.

## Reproducing

`npm run e2e:status-list` → *"durable (survives a fresh Warden), fail-closed, version-pinned +
audit-replayable, controller-enforced, random-indexed, and fixed herd-size."* Every DID minted on
`registry: local`.
