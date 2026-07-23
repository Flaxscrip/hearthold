# The Partition Ladder — Results

Replaces the single partition + single tier with a **ladder of partitions**, each gated on **two
independent axes** — the presenter's **recognition tier** AND the query's **arrival depth** — both of which
must hold. This is the surface a Sovereign actually configures. Run **live** against Archon
(`@didcid/keymaster` 0.6.0 → `flaxlap.local:4222`, `registry=local`).

- Implementation: [`packages/core/src/mesh.ts`](../../packages/core/src/mesh.ts) (`Partition`, `PartitionLadder`, `permittedPartitions`, `reasonOverPartitions`, `MeshWarden`)
- Matrix + demo: [`scripts/e2e-partition-ladder.ts`](../../scripts/e2e-partition-ladder.ts) — `npm run e2e:partition-ladder`

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass' HEARTHOLD_REGISTRY=local \
       HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_DATA_ROOT="$(mktemp -d)"
npm run e2e:partition-ladder
```

## Why two axes, not one

"A direct close friend" and "a stranger whose query reached me through two trusted hops" are both
loosely-trusted — for **different reasons**. Collapse them into one number and *"reached me through trusted
friends"* silently becomes *"I trust them"* — the **transitivity trap**. So recognition-tier and
arrival-depth stay separate: a partition declares a requirement on **each**, and **both must hold** (ANDed).
Tier and depth are never merged into a single score.

## The model

- A **`Partition`** has `{ name, domain, facts, access }` where `access = { minTier, maxArrivalDepth,
  minPathConfidence? }`.
- A **`MeshWarden`** holds an ordered **`PartitionLadder`** (rungs), not one partition.
- **Tier ordering is EXPLICIT** — `policy.tierOrder` is a low→high list; a tier's rank is its index. Names
  are never string-compared (that is a bug waiting to happen); everything ranks through the list. A tier not
  in the list has no rank and reaches nothing.
- **Arrival depth** is how many hops the query travelled from the origin — 1 at the first hop, **incremented
  on each forward** (set by the sender, honoured by the recognizing receiver, like `depthRemaining`).
- On a query, `permittedPartitions(...)` computes the reachable rungs — **deny by default**: a rung is
  included only if `tierRank ≥ minTierRank` **AND** `arrivalDepth ≤ maxArrivalDepth` (plus the optional
  confidence floor). Reasoning is **SANDBOXED** to that set: a fact in a gated rung is *unreachable*, not
  merely unranked.

## The demo — a realistic three-rung ladder (fence-builder)

| Rung | `minTier` | `maxArrivalDepth` | Fact |
|---|---|---|---|
| **world-public** | `world` | 2 | "set posts 8 ft on center" (general advice) |
| **acquaintance** | `acquaintance` | 2 | "my contractor charges ~$45/linear foot" |
| **close-friend** | `close-friend` | 1 | "the side gate code is 4-8-1-5" (personal) |

`tierOrder = ['world', 'acquaintance', 'close-friend']`. So a `world` presenter reads only the general
advice; an `acquaintance` reads that plus the contractor rate; a `close-friend` — and only when arriving
**directly** (depth 1) — reads the gate code. A close friend whose query reached B *through a relay* (depth
2) does **not** get the gate code: reaching B through trusted hops is not the same as being trusted with the
gate code.

## Test matrix — every case the expected verdict (live)

A correct no-answer is a PASS; access is never widened to go green.

| Case | Result |
|---|---|
| WORLD-PUBLIC | a `world` presenter gets the world-public fact; is **denied** the acquaintance and close-friend facts |
| TIER-GATING | an `acquaintance` reads its own rung but is **denied** the close-friend fact **even though the query matches it** |
| DEPTH-GATING | a `close-friend` at depth 1 gets the gate code; the **same presenter at depth 2 is denied** (rung is depth-1-only) |
| AXIS-INDEPENDENCE | for the same rung: high-tier-but-too-deep **denied**, low-tier-but-shallow **denied**, only both-satisfied granted |
| SANDBOXING | the answer's content comes **only** from a permitted rung; a gated rung's fact never leaks |
| INDISTINGUISHABILITY | a query hitting a gated rung and one matching nothing return **byte-identical** responses |
| LADDER-ORDER | inserting a tier in the middle does not re-rank the others; ranks are explicit indices |

### AXIS-INDEPENDENCE — the two axes are ANDed, proved

For the **same** close-friend rung (`minTier: close-friend`, `maxArrivalDepth: 1`), three presentations:

- **close-friend @ depth 2** → **denied** (tier fine, depth too deep),
- **acquaintance @ depth 1** → **denied** (depth fine, tier too low),
- **close-friend @ depth 1** → **granted** (both hold).

Neither axis alone unlocks the rung; only their conjunction does. Depth cannot buy tier, and tier cannot buy
depth.

### SANDBOXING — a gated fact is unreachable, not unranked

The reasoning (`reasonOverPartitions`) iterates **only** the permitted rungs, so it cannot see a gated
rung's facts at all. A `world` presenter asking "what is the gate code?" — which matches **only** the gated
close-friend rung — gets no-answer; the gate-code string is never in the reasoning's input, so it cannot
leak into the answer.

### INDISTINGUISHABILITY — "no answer" is not an oracle

A query that **hits a gated rung** (world presenter → gate-code query) and a query that **matches nothing at
all** (world presenter → paint-colour query) produce **byte-identical** responses. Verified directly
(`JSON.stringify` equality). Otherwise "no answer" would leak whether a fact exists in a partition you can't
reach — turning the deny into an oracle. Because the reasoning literally cannot see gated rungs, the two
cases are the same code path.

## Transcript (the demo narrative)

```
▸ B's three-rung ladder: world-public (tier world, depth ≤2) · acquaintance (acquaintance, ≤2) · close-friend (close-friend, depth 1 only)
    world-public → "set posts 8ft on center"   acquaintance → "$45/linear foot"   close-friend → "gate code 4-8-1-5"

WORLD-PUBLIC   world  → post-spacing ✓ ; contractor-rate DENIED ; gate-code DENIED
TIER-GATING    acquaintance → contractor-rate ✓ ; gate-code DENIED (matches, but tier too low)
DEPTH-GATING   close-friend @1 → gate-code ✓ ; close-friend @2 → DENIED (depth-1-only rung)
AXIS-INDEP.    close-friend@2 DENIED ; acquaintance@1 DENIED ; close-friend@1 GRANTED
INDISTINGUISH. gated-hit response ≡ genuine-miss response  (byte-identical)
```

## All existing suites still pass live

`e2e:mesh`, `e2e:mesh-depth2`, `e2e:status-list`, `e2e:attenuation`, `e2e:disclosure` — all migrated to the
ladder (single-rung where they had one partition) and green. The depth-2 relay increments `arrivalDepth`, so
C answers a two-hop query only if its rung permits depth 2.
