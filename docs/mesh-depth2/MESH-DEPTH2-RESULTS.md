# Trusted-Knowledge Mesh — Depth-2 Results

Depth-2 propagation: a query A's Emissary cannot answer at friend **B** is forwarded by B to B's friend
**C**, and C's answer returns along the path — with **budget, depth, and confidence all attenuating** at
each hop. Run **live** against Archon (`@didcid/keymaster` 0.6.0 → `flaxlap.local:4222`, `registry=local`).
Strictly two hops; depth > 2 is deferred.

- Module: [`packages/core/src/mesh.ts`](../../packages/core/src/mesh.ts) (extends v1)
- Matrix + 3-node loop: [`scripts/e2e-mesh-depth2.ts`](../../scripts/e2e-mesh-depth2.ts) — `npm run e2e:mesh-depth2`

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass' HEARTHOLD_REGISTRY=local \
       HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_DATA_ROOT="$(mktemp -d)"
npm run e2e:mesh-depth2
```

## The two fix-firsts (resolved as part of depth-2)

- **DEPTH AUTHORITY.** v1 issued `recognition.maxDepth` but never enforced it. Now `maxDepth` is **disclosed**
  (`RECOGNITION_DISCLOSE`) and each hop enforces **both** axes: the effective reach is
  `min(recognition-authorized, partition-permitted)`. Concretely, admission rejects when the query's
  `depthRemaining` exceeds `min(recognition.maxDepth − 1, policy.maxRelayDepth)`. This is what makes
  RECOGNITION-DEPTH-BOUND a real reject: a `maxDepth 1` recognition authorizes **0** forwards, so it cannot
  reach C no matter what the partition permits.
- **VERIFICATION ≠ RECOGNITION (structural, not caller convention).** A verifies C's signature without
  recognizing C. The mesh (`receiveForwardedAnswer`) assembles the path from **two** signatures — B's relay
  assertion (A recognizes B → trusts it) and C's answer signature (verified, not recognized) — and records
  `recognizesAnswerer: false` with a path of `A →recognizes→ B →recognizes→ C`. No `A→C` edge is ever
  synthesized; "A trusts C" is impossible to express.

## The loop (and what it reuses)

The invariant holds: **every hop, including B→C, is an Emissary→foreign-Warden crossing.** B's Warden cannot
answer, so B's **own Emissary** visits C under B's **own** recognition of C; C serves because C trusts B,
not A. B's Warden never holds C's handle — only a `reachFriend` crossing callback (its Emissary).

| Attenuating axis | Mechanism (reused) |
|---|---|
| **Budget** (categorical scope + numeric) | `budgetSubset(forward, incoming)` — attenuation `isSubset` (scope) + `≤` (maxNodes/rate), per hop, before B crosses |
| **Depth** | `depthRemaining` strictly decrements; forward allowed only while ≥ 1; bounded by `min(recognition, partition)` |
| **Confidence** | path confidence = **product** of each edge's recognition confidence (0.9 ∘ 0.8 = 0.72), ≤ any single hop |
| **Recognition** (selective-disclosure) | A/B present only `{subject, tier, recognitionId, confidence, maxDepth}` |

## Test matrix — every case the expected verdict (live)

A correct REJECT is a PASS; admission and verification were never loosened.

| Case | Expected | Result (real output) |
|---|---|---|
| HAPPY-2HOP | ACCEPT | C answers `post-spacing` (asserted); A verifies C's signature; composed confidence **0.72**; full A→B→C path |
| NON-TRANSITIVE-TRUST | structural | `recognizesAnswerer = false`; C-edge basis `"B recognizes C"`; no `A→C` edge; `verifiedSigner = C` |
| RECOGNITION-DEPTH-BOUND | REJECT | `depthRemaining 1 exceeds the permitted 0 (recognition authorizes 0 forward(s), partition permits 1)` (check `depth`) |
| DEPTH-STOP | REJECT | `propagation depth exhausted (depthRemaining 0) — cannot forward further` (check `depth`) |
| BUDGET-ATTENUATION | REJECT | `forward maxNodes 5 exceeds incoming 1`; and over-scope `mode:reasoning ⊄ mode:fact` |
| BROKEN-RELAY-RECOGNITION | no-answer | `no recognized friend covers this domain — clean no-answer` (never a fabricated answer) |
| CONFIDENCE-MONOTONICITY | ≤ each hop | `0.72 ≤ min(0.9, 0.8)` and ≤ every edge |
| CONFIDENTIALITY-2HOP | opaque legs | both legs pairwise-encrypted; **B (relay) can decrypt** leg C→B; a 4th party can decrypt **neither** leg |
| CYCLE | REJECT | `cycle: <did>… is already on the path` (check `cycle`) |

### NON-TRANSITIVE-TRUST — called out

C answered because **B** recognizes C. The returned, mesh-assembled path labels the C-edge `"B recognizes C"`
and carries `recognizesAnswerer: false`; there is no `A→C` edge and no way to record one. A **verified** C's
Warden signature (`verifiedSigner = C`) purely as cryptography — that verification is explicitly separated
from recognition, so "A trusts C" is never implied or storable.

### RECOGNITION-DEPTH-BOUND — called out

With A's recognition set to `maxDepth 1` (authorizing 0 forwards) but the query needing a forward to reach C,
B rejects at admission: `depthRemaining 1 exceeds the permitted 0`. This proves the **recognition's own
depth governs**, not merely the partition policy — the fix-first that v1 lacked.

### CONFIDENTIALITY-2HOP + QUERY-EXPOSURE — called out

Both return legs are pairwise-encrypted Archon assets. Verified directly: a 4th party's `decryptJSON` throws
on **both** the C→B and B→A legs, while **B (the relay) can decrypt** the C→B leg — B necessarily learns the
answer to re-package it. **Query exposure (the querier-privacy boundary), proven not assumed:**

- **B learns** A's query text **and** A's identity (A presented directly to B).
- **C learns** the query text (forwarded) but **not A** — B forwards under **B's** Emissary DID, and A's
  Emissary DID does **not** appear anywhere in the B→C envelope (asserted on the wire).
- A 4th party observing either leg learns nothing.

This is trust-gated, **not** query-confidential: B and C both see the query. Hiding the query from the
answering node is PIR — out of scope (see FINDINGS).

## Happy-path transcript (composed confidence + full provenance)

```
▸ HAPPY-2HOP: A→B→C answers; A verifies C's signature, sees composed confidence 0.72 + full path
  ✓ B forwards, C answers, B returns a granted (encrypted) forwarded answer
  ✓ A decrypts + verifies C's Warden signature (verification)
  ✓ composed path confidence = 0.9 × 0.8 = 0.72
  ✓ full A→B→C provenance path assembled by the mesh
    ── evidence graph (rendered) ──
      reference:  post-spacing (asserted — C asserts, forwarded by B)
      path:       <A>→<B> [A recognizes B @0.9]   <B>→<C> [B recognizes C @0.8]
      confidence: 0.72 (composed, ≤ each hop)
      narrative:  Sovereign C asserts: set posts 8 feet on center, 2 feet deep in concrete.
```

The query crossed A→B→C; the answer came back a signed, pairwise-encrypted evidence graph carrying C's
personal assertion, the trust path with per-edge basis and confidence, and the composed path confidence —
and A verified C's Warden signature without ever recognizing C.

## Reproducing

`npm run e2e:mesh-depth2` → *"budget, depth, and confidence all attenuate; verification ≠ recognition."*
Three nodes isolated under `A/`, `B/`, `C/` sub-roots; every DID minted on `registry: local`.
