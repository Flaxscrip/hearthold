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
| **B6 GATEKEEPER PURITY** | OBSERVATIONAL (source scan for `importDIDs`/`importBatch`) | **RED** |

Only **B1** has a STRUCTURAL leg. The rest are observational and should be hardened toward structural where
possible (e.g. a nominal `SealedForRecipient<DID>` type for B4, a branded `LocalOnlyGatekeeper` for B6)
rather than left as scans.

## B6 is RED — and that is the most valuable output

**`packages/core/src/credential-delivery.ts:177` calls `handle.gatekeeper.importDIDs(m.ops)`** — importing a
counterparty's VC + schema (and, opt-in, its issuer) operations into the **node's own Gatekeeper** (the
handle's client points at `config.nodeUrl`). On a local-first node **with a Hyperswarm mediator**, that
import makes this node a **re-broadcaster** of the counterparty's identifiers (the *holding is republishing*
property, [`../DEPLOYMENT.md`](../DEPLOYMENT.md)). So the credential-delivery path, as built, violates
GATEKEEPER PURITY.

This is **not weakened to go green** (per the batch constraint). The resolution is already designed, not
hacked: the **DMZ** — an ephemeral, **mediator-less** Gatekeeper that verification imports target instead of
the node's own peer-connected one (see [`../DRAWBRIDGE-GROUNDING.md`](../DRAWBRIDGE-GROUNDING.md)). A
Gatekeeper with no gossip mediator has nothing to propagate through, so importing to verify no longer
republishes. Until credential-delivery routes its `importDIDs` into a DMZ, **B6 stays RED** — which is
exactly the regression signal we want: the debt is now a failing invariant, not a paragraph.

Note the import is *best-effort* and short-circuits to the native path on a shared-registry node (it only
runs when the VC isn't already resolvable), so the violation bites specifically on the true cross-node,
peer-connected deployment — the one the DMZ is for.

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
