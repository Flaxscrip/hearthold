# Durable Recognition Revocation — Results

Replaces the in-memory revocation `Set` with a real, durable, verifiable mechanism: a **RevocationList
published as an Archon asset**, owned by the issuing Sovereign, resolvable and version-pinned — with the
revocation check **bound into the signed answer** so a dispute can be settled after the fact. Run **live**
against Archon (`@didcid/keymaster` 0.6.0 → `flaxlap.local:4222`, `registry=local`).

- Module: [`packages/core/src/revocation.ts`](../../packages/core/src/revocation.ts) (+ `MeshWarden.admit` wired to it)
- Blocker smoke (Task 1): [`scripts/smoke-revocation-api.ts`](../../scripts/smoke-revocation-api.ts)
- Test matrix: [`scripts/e2e-revocation.ts`](../../scripts/e2e-revocation.ts) — `npm run e2e:revocation`

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass' HEARTHOLD_REGISTRY=local \
       HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_DATA_ROOT="$(mktemp -d)"
npm run smoke:revocation   # Task 1 blocker check
npm run e2e:revocation      # the full matrix
```

## What was actually broken (and what wasn't)

The issuer and the checker are the **same node** (B's Sovereign issues, B's Warden checks), so the gap was
never *distribution*. It was: **persistence** (revoke, restart, and the `Set` forgets), **multi-instance**
(two Wardens don't share state), **verifiability** (nothing was signed), and **auditability** (no record of
*when*, so "you answered under a revoked recognition" was unfalsifiable). All four are closed here.

## The model

Archon stays dumb: it stores, versions, and **controller-checks** an opaque signed blob — it never
understands "revocation." Version pinning reuses the attenuation discipline exactly (record **both** the
integer `versionSequence` and the content-addressed `versionId`; assert they match on resolve).

1. **List as an Archon asset.** The issuing Sovereign owns a `RevocationList` (its own `did:cid`),
   `addProof`-signed, holding `{recognitionId, revokedAt}` entries + `listVersion` + issuer DID. Revoking =
   append + update; Archon's `versionSequence` gives an immutable, content-addressed history for free.
2. **Check at admission, FAIL-CLOSED.** `MeshWarden.admit` resolves the list through a `RevocationResolver`
   (max-age cache) and rejects if the presented `recognitionId` appears. If the list is unresolvable, unsigned,
   signed by the wrong issuer, or the cache is stale and re-resolution fails → **DENY**. Never fails open.
3. **Bind the check into the answer.** The signed `MeshAnswer` gains `revocationCheckedAt` +
   `revocationListVersion` (the pinned `{versionSequence, versionId}`) — inside the `addProof` signature, so a
   dispute is settleable: resolve that exact version and confirm the `recognitionId` was absent then.

### Schema (`packages/core/src/revocation.ts`)

```ts
interface RevocationEntry { recognitionId: string; revokedAt: string; }     // opaque id only
interface RevocationListBody { issuer: string; listVersion: number; entries: RevocationEntry[]; updatedAt: string; }
type SignedRevocationList = RevocationListBody & { proof };                   // Sovereign addProof
interface RevocationListPin { listDid: string; versionSequence: number; versionId: string; checkedAt: string; }

// MeshAnswer gains (both inside the signature):  revocationCheckedAt?: string;  revocationListVersion?: RevocationListPin;

// issuer:  createRevocationList()·publishRevocation() (idempotent)
// checker: RevocationResolver{ maxAgeMs, check()→{available,revoked,pin} }  ·  auditRevocationAt(pin, id)
```

## Test matrix — every case the expected verdict (live)

A correct REJECT is a PASS; the checker was never loosened.

| Case | Expected | Result (real output) |
|---|---|---|
| HAPPY | ACCEPT | answer carries `revocationCheckedAt` + pinned list version (`seq 1`, `versionId …`) |
| REVOKED-PUBLISHED | REJECT | `recognition has been revoked (published list)` (check `revocation`); re-revoke is idempotent (no new version) |
| PERSISTENCE | REJECT | a **fresh Warden with no in-memory state** reads the published list and rejects |
| FAIL-CLOSED | REJECT | `revocation status unavailable — deny (fail-closed): … revocation list unresolvable: Invalid DID` |
| STALENESS | REJECT | stale cache + failed re-resolution → deny (fail-closed) |
| AUDIT-REPLAY | settled | pinned version's `versionId` matches; `recognitionId` absent then; current list contains it, historical version still does not |
| CONTROLLER-TAMPER | REJECT | Archon refuses a non-Sovereign `mergeData`; list unchanged (no forged entry) |
| PRIVACY | opaque | list holds only opaque `recognitionId`s — no holder/Emissary DIDs, no domains |

### PERSISTENCE — called out (the test the in-memory Set fails)

After a revocation is published, a **brand-new `MeshWarden` constructed with a fresh resolver and zero
in-memory state** resolves the durable list from Archon and **rejects**. This is exactly the case the old
`Set` failed: revoke → restart → the recognition was live again. Durability now comes from the asset, not
process memory.

### FAIL-CLOSED — called out

An **unresolvable** list (bad/nonexistent DID) causes admission to **DENY**, even for an *unrevoked*
recognition — `revocation status unavailable — deny (fail-closed)`. Same for a stale cache whose
re-resolution fails (STALENESS). The revocation fact being unavailable is never treated as "not revoked";
it matches the deny-by-default admission posture. It never fails open.

### AUDIT-REPLAY — called out (disputes are settleable)

The HAPPY answer pinned `{versionSequence, versionId}` of the list at check time. Verified end to end:
resolving that **exact pinned version** returns a list whose `versionId` matches the answer and in which the
`recognitionId` was **absent** — so "was it revoked when B answered?" is decidable from the signed answer
alone. After a later revocation, the **current** list contains the id while the **pinned historical version
still does not** (immutable, content-addressed history). "Your Warden answered under a revoked recognition"
is now falsifiable.

## Reproducing

`npm run e2e:revocation` → *"durable (survives a fresh Warden), fail-closed, version-pinned +
audit-replayable, controller-enforced, and privacy-scoped."* Nodes isolated under `A/` and `B/`; every DID
minted on `registry: local`. The `MeshWarden` legacy in-memory `revoked` Set still works when no resolver is
configured (v1/depth-2 e2es unchanged); the durable resolver is preferred whenever set.
