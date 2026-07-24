# PVM ↔ Hearthold vocabulary mapping

Hearthold is the layer that gets **sold, explained, and audited**, so it deliberately does not adopt PVM's
(Privacy-Mage's) magical vocabulary. This table lets an auditor trace each Hearthold term back to the PVM
concept it implements — and, just as importantly, keeps two concepts that PVM keeps separate from ever being
merged in our code or prose.

## The correspondence

| PVM term | PVM role | Hearthold term | Where in Hearthold |
|---|---|---|---|
| **G — guilds** | a collective / issuing body a principal belongs to | **Sphere** | membership credentials, issuer orgs, KB collectives, the outward trust registry |
| **S — scope** | the context/compartment a disclosure is bounded to | **partition** | `packages/core/src/mesh.ts` (`Partition`, `PartitionLadder`, `permittedPartitions`) |

## Why they must never be merged

In PVM's value function the access decision is **multiplicatively gated**: the guild term **G** and the
scope term **S** are *distinct factors*, both required, neither substitutable — a principal reaches a value
only when their guild standing **and** the scope both admit it. Collapsing G into S (or vice-versa) silently
changes the gate from a conjunction to a single axis, which is exactly the transitivity/rank-conflation trap
the partition ladder is built to avoid (see [`partition-ladder/FINDINGS.md`](partition-ladder/FINDINGS.md)).

So in Hearthold:

- **Sphere** answers *"which collective/issuer is this, and does the principal belong to it?"* — the **G**
  factor. A Sphere is a body one is a **member of**; publishing to a sphere with peers is a disclosure to
  its members.
- **partition** answers *"which compartment of my knowledge may this disclosure be drawn from?"* — the **S**
  factor. A partition is a **rung** gated by recognition tier ∧ arrival depth ∧ path confidence.

They are different types on different code paths. A Sphere is never a partition and must never be added to
the `PartitionLadder`; a partition is never a Sphere. Keep the words apart in prose too — "publish to a
sphere" and "read from a partition" are not interchangeable phrasings.

## Rename provenance (Guild → Sphere)

"Guild" (PVM's word) was renamed to "Sphere" across the **product/audited surface**: `@hearthold/core`,
`warden`, `sovereign`, the apps, the architecture/feature docs, and the product e2e scripts
(`GuildMembership` → `SphereMembership`, "guild issuer/manager/registry" → "sphere …", `guildId` →
`sphereId`, etc.). Naming only — no behaviour change; `npm run e2e:prove-didcomm` and the build stay green.

### Deliberate exclusion — the fictional game-of-42 world

One place keeps the literal word "guild": the self-contained **game-of-42 role-play demo**
(`demos/game-of-42/*`, and the scripts dedicated to it — `roleplay-*`, `seat-drake-gamers`,
`seal-game-of-42`, `forge-citykey`, `proto-vwc`), whose in-world org is the fictional **"Drake Gamers
Guild."** That is a *gaming clan* — the ordinary English sense of "guild" — **not** PVM's G concept, so
renaming it to "Sphere" would misdescribe it (a gaming clan is not a Sphere) and add churn (binary fixture
assets, cross-file fixture-path references) with no audit value. The proper noun "Drake Gamers Guild" is
therefore preserved verbatim wherever it appears, including as inline flavor inside a few product e2e
scripts. If a future policy wants even the fictional world renamed, it is a mechanical follow-up isolated to
that demo.
