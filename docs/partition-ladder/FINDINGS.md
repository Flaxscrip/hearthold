# The Partition Ladder — Findings

What the two-axis design required, what was easy or awkward, and an explicit **DEFERRED-SCOPE**. Grounded on
real calls against a live node (`flaxlap.local:4222`, `registry=local`); harness:
`npm run e2e:partition-ladder`.

## Verdict

The ladder works as specified: two independent axes (recognition tier ∧ arrival depth), ANDed, deny by
default, reasoning sandboxed to the permitted rungs, tier ranking explicit, and "no answer"
indistinguishable from a genuine miss. This is almost entirely Hearthold logic — Archon is uninvolved beyond
the recognition it already signs. The single-partition/single-tier model is replaced, not kept alongside;
all existing mesh suites are migrated to the ladder and pass live.

## The transitivity trap (why the axes must stay separate)

Recognition tier answers "how much do I trust *this presenter*." Arrival depth answers "how far did the
*query* travel to reach me." They are different questions, and a single "trust score" would conflate them:
"reached me through two trusted hops" would collapse into "I trust them at tier-2." The whole point of a
mesh is that trust is **not** transitive — A trusts B, B trusts C, but A does not thereby trust C (proved in
the depth-2 work). Merging depth into tier would smuggle transitivity back in through the partition gate. So
`permittedPartitions` checks the two axes with **two separate comparisons** and ANDs them; there is no code
path where a high tier compensates for too-great a depth, or vice versa (AXIS-INDEPENDENCE).

## What was straightforward

- **Explicit ranking is a list index.** `policy.tierOrder` is a low→high array; a tier's rank is
  `indexOf`. No string comparison of tier names (which would silently mis-rank on a rename or a new tier).
  Inserting a tier in the middle re-indexes cleanly and does not re-rank the rungs above it (LADDER-ORDER).
- **Sandboxing falls out of the data flow.** `reasonOverPartitions` is handed **only** the permitted rungs,
  so a gated fact is not in its input at all — it is *unreachable*, not filtered-after-the-fact. There is no
  place for cross-partition leakage because the reasoner never sees the gated partitions.
- **Indistinguishability is one constant response.** "No permitted answer" returns a single fixed
  `no-answer` — the same whether a gated rung matched or nothing matched. Because the reasoner can't see
  gated rungs, both cases are literally the same branch; the test confirms byte-identical responses.

## Design notes worth stating

- **Arrival depth is threaded, not re-derived.** The query carries `arrivalDepth` (1 at the origin,
  incremented on each forward by the relay). A presenter can only *inflate* its own depth, which merely
  **restricts** its access — there is no incentive, and no attack, in the depth axis; depth accrues only
  through trusted relays that increment it honestly (the same trust model as `depthRemaining`/`visited`).
- **Composed path confidence, for the optional `minPathConfidence` axis.** Each hop multiplies the
  presenter's local edge confidence into `query.pathConfidence`, so the answering node gates on the **whole
  path's** confidence (A→B→C = 0.9 × 0.8), not just its local edge — the same composition A recomputes on
  return. Optional: a rung without `minPathConfidence` ignores it.
- **Admission vs. gating are cleanly separated.** `admit()` verifies the recognition and revocation and
  forwarding authority; it no longer checks a single tier or a single arrival depth. The **ladder** decides
  which rungs the answer may come from, in `handle()`. Admission says "this is a valid, unrevoked
  recognition"; the ladder says "…and here is exactly what it may read."

## DEFERRED-SCOPE — named, not built

- **Per-rung provenance / confidence blending.** A rung's facts carry their own provenance/confidence; the
  answer surfaces one fact's. Combining facts across permitted rungs, or ranking multiple hits, is not built
  (the reasoner returns the first match).
- **Query-side minimum tier.** A presenter can ask a query that matches a gated rung and get a (constant)
  no-answer. There is no separate "you may not even ASK about X" gate — hiding the *existence* of a topic is
  stronger than hiding its contents and is out of scope (INDISTINGUISHABILITY already prevents the answer
  from leaking existence).
- **Dynamic / per-query ladders.** The ladder is per-Warden and static here. A ladder that varies by
  requester attributes beyond (tier, depth, confidence) is not modelled.
- **Real reasoning.** `reasonOverPartitions` is a keyword lookup; an LLM restricted to the permitted rungs
  would slot in identically (the sandbox is the permitted-set boundary, not the lookup method), but the
  prompt-injection surface of an LLM reasoner over private partitions is its own problem, deferred.

## Residuals / next steps

- **Confidence-floor rungs** (`minPathConfidence`) are wired and threaded but not exercised by a dedicated
  matrix case here — a natural addition.
- **LLM-backed reasoning** over the permitted set is the obvious upgrade to `reasonOverPartitions`, with the
  sandbox boundary unchanged.
