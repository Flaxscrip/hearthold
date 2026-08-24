# Trusted-Knowledge Mesh — Depth-2 Findings

What the two fix-firsts required, what Archon made easy or awkward, and an explicit **DEFERRED-SCOPE**
section. Grounded on real calls against a live node (`flaxlap.local:4222`, `registry=local`); the harness is
[`scripts/e2e-mesh-depth2.ts`](../../scripts/e2e-mesh-depth2.ts) (`npm run e2e:mesh-depth2`).

## Verdict

Depth-2 closes end-to-end and every negative test rejects at the intended check. Budget, depth, and
confidence all attenuate per hop, reusing the attenuation model (`isSubset` + `≤`) and selective-disclosure
(the recognition). The invariant held — every hop, including B→C, is an Emissary→foreign-Warden crossing;
B's Warden holds only a `reachFriend` crossing callback, never C's handle. v1 still passes unchanged.

## The fix-firsts, resolved

- **Depth authority now governs.** `recognition.maxDepth` is disclosed and enforced: each hop rejects when
  `depthRemaining > min(recognition.maxDepth − 1, policy.maxRelayDepth)`. **Both** must hold — the recognition
  the querier holds AND the partition it arrives at, whichever is tighter. Depth semantics: `depthRemaining`
  = forwards still allowed; a `maxDepth k` recognition authorizes `k−1` forwards; it strictly decrements on
  each forward and a node forwards only while it is ≥ 1. This is what makes A's recognition — not just B's
  partition — able to stop propagation (RECOGNITION-DEPTH-BOUND).
- **Verification ≠ recognition is structural.** `receiveForwardedAnswer` is the mesh assembling
  path-provenance from two signatures (B's relay assertion + C's answer signature) and emitting
  `recognizesAnswerer: false` with an `A→B→C` path that has no `A→C` edge. The caller cannot turn "verified
  C's signature" into "recognizes C" — the type doesn't allow it and no code path records it.

## What Archon made easy

- **Two-signature provenance is just two `addProof`s that survive re-encryption.** B forwards C's signed
  answer *intact* (C's proof rides through B's `decryptJSON`/re-`encryptJSON` untouched) and adds its own
  signed relay assertion. A verifies both independently. No special envelope format — the same
  `addProof`/`verifyProof` used everywhere.
- **Per-leg confidentiality is free and composable.** Each return leg is an `encryptJSON` to the next hop's
  Emissary. The relay B *must* decrypt the C→B leg to re-package, which is exactly the "B learns the answer"
  property; a 4th party decrypts neither leg. Verified on the wire.
- **Querier hiding from C fell out of the design.** Because B forwards under **B's** Emissary (C serves B,
  not A), A's identity simply isn't in the B→C envelope — asserted directly. A partial, honest querier-privacy
  property with no extra machinery (the query *text* is still visible; see DEFERRED).
- **Cycle detection is a `visited` list.** Since a path is carried for provenance anyway, rejecting a forward
  to an already-visited Warden is one check.

## What Archon made awkward (and the workaround)

- **Numeric budget still isn't set-⊆ — same split as v1, now per hop.** `budgetSubset` keeps categorical
  scope on attenuation `isSubset` and adds `≤` for `maxNodes`/`rate` (plus a strict-decrement check on
  `depthRemaining`). Both broaden-attempts (over-budget and over-scope) were exercised and rejected.
- **"Warden never faces a foreign node" remains an architecture property we enforce, not an Archon feature.**
  Forwarding is a `MeshForwarding` capability whose Emissary crosses via `reachFriend`; the harness wires it
  to the friend's `MeshWarden.handle` in-process (as CGPR models the A2A gateway). The Warden only ever
  receives a neutral result back.
- **Revocation is still logic, not mechanism.** v1's in-memory revocation set carries over; publishing it as
  a resolvable Archon asset is unchanged and still deferred.

## DEFERRED-SCOPE — what depth-2 does NOT do (named, not built)

- **Depth > 2, and parallel fan-out.** This is a single relay path, strictly two hops. C cannot forward
  (DEPTH-STOP), and B forwards to exactly one friend — no fan-out to many friends at once, no depth-3+.
- **Querier privacy beyond naming it.** B and C both **see A's query text** (trust-gated, not confidential).
  The only querier hiding here is that C does not learn A's *identity*; the query *content* is exposed to
  every hop. Hiding the query from the answering node is **Private Information Retrieval** — the hard upgrade,
  explicitly out of scope. Documented per hop: B learns query + A; C learns query, not A.
- **Recognition-graph privacy.** Who-recognizes-whom is visible within the trusted group (recognitions name
  subject + issuer, and the relay assertion names the edge). Hiding the trust graph is BBS+/anon-cred tier.
- **Unlinkability across presentations.** Recognitions and answers carry stable issuer signatures, so repeat
  presentations correlate — the same boundary as selective-disclosure. Unlinkable presentation is BBS+ tier.
- **Semantic vocabulary alignment.** A, B, C share a claim vocabulary (`domain`, `mode`, fact `reference`s);
  negotiated cross-node schemas are deferred.
- **Revocation-freshness as a published Archon asset.** Still an in-memory policy set — logic, not mechanism.

## Residuals / next steps

- **Depth > 2** generalizes the same primitives (decrementing `depthRemaining`, per-hop `budgetSubset`,
  composing another confidence factor, appending a relay assertion) — the shape is set; only the recursion
  and loop-prevention hardening remain.
- **Fan-out** would run several `reachFriend` crossings and merge answers with per-branch provenance.
- **PIR** (query privacy) and **BBS+** (trust-graph privacy + unlinkability) remain the two hard upgrades;
  naming them keeps depth-2 honest about what "trust-gated" buys.
