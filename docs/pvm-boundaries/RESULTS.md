# PVM-BOUNDARIES — Results

The architectural invariants that otherwise live only in prose — the ones that erode **silently** in a
refactor — encoded as a suite so a regression goes RED. Run live against Archon
(`flaxlap.local:4222`, `registry=local`): `npm run e2e:pvm-boundaries`.

Implementation: [`scripts/e2e-pvm-boundaries.ts`](../../scripts/e2e-pvm-boundaries.ts).

## STRUCTURAL vs OBSERVATIONAL

Each check is tagged, because the two are not equally strong:

- **STRUCTURAL** — enforced by the **type system**; the guard is a `@ts-expect-error` (or a type shape) the
  build (`tsc`) checks. If the invariant breaks, the **build fails before the suite runs**. Strong: it
  proves the bad program *cannot be written*, not merely that one example didn't misbehave.
- **OBSERVATIONAL** — checked at **runtime** by scanning a real wire artifact or the source. **Weaker**: it
  catches what it looks for, not what it doesn't. A cleverly-named leak, or an import through an alias the
  scan doesn't match, would pass. Read these as tripwires, not proofs.

| Invariant | Enforcement | Verdict |
|---|---|---|
| **B1 CUSTODIAN/ACTOR SEPARATION** | STRUCTURAL (`@ts-expect-error` on the `MeshWarden` ctor) + OBSERVATIONAL (no network client in `mesh.ts`) | GREEN |
| **B2 HUMAN ROOT** | OBSERVATIONAL (behavioural: admission rejects a non-Sovereign root) | GREEN |
| **B3 PROVE-THE-FACT** | OBSERVATIONAL (scan the decrypted answer for sibling-rung facts) | GREEN |
| **B4 PAIRWISE DISCLOSURE** | OBSERVATIONAL (only the intended recipient decrypts) | GREEN |
| **B5 NO REPUTATION** | OBSERVATIONAL (scan the return struct for an aggregate score) | GREEN |
| **B6 GATEKEEPER PURITY** | **STRUCTURAL** (`PrivateGatekeeper` omits import; `@ts-expect-error`) + OBSERVATIONAL (imports confined to `dmz.ts`) | **GREEN** |

**B1 and B6 have a STRUCTURAL leg.** The rest are observational and should be hardened toward structural
where possible (e.g. a nominal `SealedForRecipient<DID>` type for B4) rather than left as scans.

## B6 — was RED, now closed STRUCTURALLY (impossible by type)

B6 was RED: `credential-delivery.ts:177` called `handle.gatekeeper.importDIDs(...)`, importing a
counterparty's operations into the **node's own** Gatekeeper — which on a peer-connected node re-broadcasts
their identifiers (*holding is republishing*, [`../DEPLOYMENT.md`](../DEPLOYMENT.md)).

It is now closed the way the batch asked — **impossible by type, not merely unobserved by a scan**:

- `KeymasterHandle.gatekeeper` is a **`PrivateGatekeeper`** = `Omit<GatekeeperClient, 'importDIDs' |
  'importBatch' | 'importBatchByCids'>` (`keymaster.ts`). Importing foreign ops into the node's own
  gatekeeper is now a **compile error**. The B6 check carries a `@ts-expect-error` on exactly that call, so
  if the type ever regains an import method, the **build fails** (the invariant can no longer regress
  silently).
- The **only** importer in the codebase is the **DMZ session** (`dmz.ts`), which owns a full client pointed
  at an ephemeral, **peerless** instance — never the node's own. The observational leg asserts every
  surviving `importDIDs`/`importBatch` call site lives in `dmz.ts`.
- `credential-delivery` was refactored accordingly: the shared-registry path accepts natively (no import);
  the cross-node path verifies in a DMZ (`openDmz`) and keeps only the minimal closure
  ([`../dmz/RESULTS.md`](../dmz/RESULTS.md)); with no DMZ wired, an unresolvable VC **fails closed** rather
  than polluting the private gatekeeper.

So the "regression signal" B6 used to be is now a **type-level wall**: the bad program does not compile.

## Notes from grounding the checks

- **B4 needs a genuinely unrelated third party.** Archon's `encryptJSON` is **encrypt-for-sender**: the
  author (here B's Warden) can decrypt its own sealed output. The first draft tested "non-recipient" using
  the Warden and mis-flagged RED; the real invariant — *a party that is neither sender nor recipient cannot
  open it* — is tested with the unrelated imposter identity X, and holds. Worth knowing: the sender always
  retains read access to what it sealed.
- **B2 roots at the Sovereign via recognition admission.** `MeshWarden.admit()` verifies the recognition
  against `policy.recognizedIssuer` (the Sovereign DID); a recognition minted by any other root fails
  `verifyPresentation` and returns `status: 'rejected'` — not exercisable. That is the human-root gate for
  the mesh path.
- **B5's confidence is decomposable by construction.** The mesh answer carries `factConfidence` (per-fact)
  and `recognitionConfidence` (per-recognition-path); the depth-2 return additionally carries `path`
  (per-edge confidences) alongside `pathConfidence`. There is no field that aggregates a *principal* into a
  single trust number — the thing NO-REPUTATION forbids. (The `score` fields elsewhere in the tree —
  `recall.ts`, citations — are search-relevance cosines, not principal reputation, and are out of this
  suite's scope.)
