# The DMZ session + keep closure — Results

Verification without republication. Closes the standing **B6 GATEKEEPER PURITY** red — and closes it
**structurally**: importing a foreign DID into the node's own Gatekeeper is now a compile error, not a scan
we hope stays clean.

- DMZ session: [`packages/core/src/dmz.ts`](../../packages/core/src/dmz.ts) — `npm run e2e:dmz`
- Keep closure: [`packages/core/src/closure.ts`](../../packages/core/src/closure.ts) — `npm run e2e:keep-closure`
- Boundary: [`../pvm-boundaries/RESULTS.md`](../pvm-boundaries/RESULTS.md) (B6 now GREEN, structural)
- Grounding for the Archon claims below: [`../DRAWBRIDGE-GROUNDING.md`](../DRAWBRIDGE-GROUNDING.md)

## Why a DMZ

The Gatekeeper stores did:cid **operations** and replays them to reconstruct a document on every resolve
(grounded: `resolveDID` is a pure DB-read + local replay, `gatekeeper.ts:698-728`). So importing a
counterparty's operations into **our own** Gatekeeper makes us hold — and, if we run a hyperswarm mediator,
re-broadcast — their identifiers. That is *holding is republishing* ([`../DEPLOYMENT.md`](../DEPLOYMENT.md)),
and it was B6's violation. The fix: route every foreign import through an **ephemeral, peerless** Gatekeeper
— a DMZ. A Gatekeeper with no gossip mediator has nothing to propagate through (grounded: the hyperswarm
mediator is the only thing that pushes ops onto the wire; `resolveDID` never touches it), so importing to
verify no longer republishes.

## The structural close (impossible by type)

`KeymasterHandle.gatekeeper` is a **`PrivateGatekeeper`** = `Omit<GatekeeperClient, 'importDIDs' |
'importBatch' | 'importBatchByCids'>`. The node's own handle **cannot** import foreign ops — it is a
compile error. The **only** full client with `importDIDs` in the whole codebase is the one a `DmzSession`
constructs, pointed at a peerless instance. B6's check carries a `@ts-expect-error` on that call, so a
regression fails the build. This is the batch's requirement met literally: *"B6 should end up impossible by
type, not merely unobserved by a scan."*

## The session lifecycle

| Phase | What happens | Co-sign? |
|---|---|---|
| **OPEN** | Warden constructs a DMZ (a full client + a Keymaster bound to a peerless instance). | No — reversible, local, publishes nothing ([`../CO-SIGN-POLICY.md`](../CO-SIGN-POLICY.md)). |
| **IMPORT** | Pull the counterparty's operation export into the DMZ. Best-effort: falls back to the native-resolvable path where import is gated; **fails closed** if a required DID doesn't resolve. | No |
| **VERIFY** | `resolveDID(verify:true)` replays the chain and re-checks **every** operation's signature, including **across key epochs** (the rotation-safety property); `verifyProof` verifies a payload against the epoch that signed it. | No |
| **DECIDE** | Compute the **keep closure** (below); the Sovereign decides what to keep. | Keep-into-a-peered-sphere is publication → co-sign; keep-local → Warden ([`../CO-SIGN-POLICY.md`](../CO-SIGN-POLICY.md)). |
| **TEARDOWN** | Destroy the session; every further call **fails closed** (`DmzSessionClosedError`); residue set is empty. The instance's data dies with the ephemeral instance. | No |

**Export is full-chain-from-genesis, no pagination** (grounded live: 9 ops, op0 = `create` with empty
`previd`). So IMPORT is everything-or-nothing per DID — the DMZ holds far more than we keep. That over-fetch
is exactly what the keep closure prunes.

**What VERIFY does NOT do — flagged.** It verifies *provenance and structural validity* (the chain is
internally consistent and signed by the key it claims), not *safety*. A well-formed, correctly-signed
credential from a dishonest issuer passes cleanly. The DMZ is the natural place to add the checks Archon
deliberately doesn't (issuer recognized? claim matches an expected schema? issuer blocklisted? which sphere
did it arrive from?) — designed in [`../DRAWBRIDGE-GROUNDING.md`](../DRAWBRIDGE-GROUNDING.md) §E.3, not built
here.

## The keep closure (Part 3) — a goal-dependent subgraph

"Keep this credential" is a **subgraph**, and the subgraph depends on **what you want to prove later**, not
the credential alone:

- **`signed-by X`** → the VC, its schema, and X's operations **to the signing version** — and nothing more.
  Later key rotations are *not* kept (they aren't needed to verify this signature).
- **`signed-by-authorized`** → additionally X's **charter** credential and **its** issuer's chain.

`computeKeepClosure(input, goal, source)` takes the **goal as an input** and returns the minimal operation
set, **version-pinned throughout**: each kept DID records both `versionSequence` and the content-addressed
`versionId` (the opid at that cut), and the kept ops are truncated from genesis to exactly that version —
the same version-pinning discipline as attenuation. Verified live (`e2e:keep-closure`): two goals over the
same statement VC produce different closures (`signed-by-authorized` reaches two more DIDs — charter +
regulator); the issuer is pinned to its **signing** version with a later rotation **excluded**; and the
smaller closure still verifies its weaker claim (the pinned signing version carries the very key that signed
the VC).

## Aegis coordination note — what a full live run needs (and why this run is a stand-in)

The batch said *coordinate, don't build containers; point at Aegis's mediator-less profile; if it isn't
ready, note what you needed.* Here is the honest state:

- **Aegis's two-node profile is running** (`aegis-*` / `aegisb-*` containers, and
  `~/isolation/aegis/deploy/two-node/`) and **is** the mediator-less model (no hyperswarm; peers linked by a
  read-only `ARCHON_GATEKEEPER_FALLBACK_URL`).
- **But its gatekeepers are `internal:true`** — no host port mapping (`docker port` returns nothing), by
  design (sealed sandbox). So from the host where Hearthold's node scripts run, **no peerless, import-open
  Gatekeeper is reachable**. flaxlap's `/dids/import` is admin-gated (401) via `:4224` and not proxied (404)
  via Drawbridge `:4222`, and no admin key is available here.
- **Consequence:** the live cross-gatekeeper demonstration — "import into the DMZ, then confirm the node's
  **own** gatekeeper never received it" — cannot run from the host, because it needs two *distinct,
  reachable* gatekeepers. `e2e:dmz` therefore points the DMZ at a **stand-in** (flaxlap `:4224`, a distinct
  client/URL over the same DB) to exercise the OPEN→IMPORT→VERIFY(across epochs)→TEARDOWN **logic**, and the
  "nothing reaches the node's own gatekeeper" invariant is carried by the **structural type guarantee**
  (which is strictly stronger than a one-off live observation).
- **What I'd need from Aegis to run it end-to-end:** a **host-reachable** endpoint for a **peerless,
  import-open** Gatekeeper (either publish node B's `:4224` to the host, or run `e2e:dmz` *inside* the Aegis
  network — e.g. add it to `harness-hearthold-delivery.sh`), plus (if node B gates admin) its import API key
  to pass as `DmzOpenOptions.apiKey`. With that, the DMZ points at node B, imports for real, and a resolve
  against node A confirms A never saw the ops.

## Test coverage

- `e2e:dmz` — fail-closed open; import; verify a VC chain and a payload proof; **verify across a key
  rotation** (pre-rotation VC still verifies); teardown leaves no residue and refuses further use; the
  structural B6 guard.
- `e2e:keep-closure` — goal-dependent, version-pinned minimal subgraphs; the weaker closure still proves its
  weaker claim; the issuer pinned to its signing version with later rotations excluded.
- `e2e:pvm-boundaries` — B6 now GREEN, structural + confined to `dmz.ts`.
- `e2e:credential-delivery` — the refactor: native accept on shared-registry; cross-node routes to the DMZ;
  no `importDIDs` into the node's own gatekeeper anywhere.
