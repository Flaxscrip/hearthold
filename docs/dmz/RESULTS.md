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

## Two properties, both required — CONFINEMENT of the capability AND ISOLATION of the target

The type guarantee and the runtime check cover **different** properties, and neither substitutes for the other:

- **Capability confinement (structural, by type).** No Hearthold path can import through the private handle —
  `PrivateGatekeeper` omits the import methods. This proves the *only* code that can import is a `DmzSession`.
- **Target isolation (runtime, at open).** That `DmzSession` holds a full client and points it at a URL —
  and "peerless" there is a **configuration** fact, not a type fact. Aim it at a peered gatekeeper (a wrong
  URL, a profile that gains a mediator, the flaxlap stand-in) and imports propagate exactly as before, with
  the compiler perfectly content. So `DmzSession.open` **interrogates the target before any session exists**
  and refuses a non-peerless one.

Confinement without isolation is a locked door in a glass wall: only the DMZ can import, but the DMZ can
still import into a node that gossips. Both are needed.

### The signal — `listRegistries()`, grounded not guessed

The direct signal is the gatekeeper's own **`listRegistries()`**: a mediator-less node can only anchor on
non-propagating registries. Grounded live — a peerless Aegis node returns `["local"]`; flaxlap returns
`["hyperswarm", "BTC:mainnet", "BTC:signet", "ETH:mainnet", "SOL:mainnet-beta", "local"]`. `PEERLESS_REGISTRIES`
is a strict allowlist (`{local}`): `hyperswarm` (the gossip mediator) or ANY blockchain registry marks the
target peered. This is a direct signal from the target, not a Hearthold-side heuristic — **no new field had
to be exposed** (see the coordination note). `assertPeerlessTarget` fails closed three ways:

- **peered** target (a propagating registry present) → `PeeredTargetError`, refused;
- **undetermined** target (unreachable / `listRegistries` errors / non-array) → `UndeterminedTargetError`,
  refused — an unverifiable target is never assumed good;
- the **only** bypass is `assumePeerless: true` — an explicit per-session escape hatch, never a default,
  never read from config, that **logs loudly**. It exists solely for a stand-in whose peerlessness is
  verified out of band.

Because the check runs inside `open()` before the session object is constructed, a refused target yields
**no session at all** — so no `import` call is reachable on a refusal (asserted).

### What this did to `e2e:dmz` (as the constraint intended)

The assertion was **not** weakened to keep the suite running against flaxlap. flaxlap is peered, so a default
DMZ open against it is now **REFUSED** — and that refusal is the `PEERED-TARGET` test passing. The lifecycle
(import/verify/teardown) runs against a genuinely peerless node when `HEARTHOLD_DMZ_URL` is set (Aegis's node
B — interrogated, no escape hatch), and otherwise against the flaxlap stand-in under the **explicit**
`assumePeerless` escape hatch, which logs loudly. The stand-in is now an acknowledged, per-session choice,
not a silent assumption.

## The session lifecycle

| Phase | What happens | Co-sign? |
|---|---|---|
| **OPEN** | Warden constructs a DMZ, **interrogates the target for peerlessness (`listRegistries()`)**, and refuses a peered/undetermined one before any session exists. | No — reversible, local, publishes nothing ([`../CO-SIGN-POLICY.md`](../CO-SIGN-POLICY.md)). |
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
  reachable* gatekeepers. `e2e:dmz` therefore runs the lifecycle against a **stand-in** (flaxlap `:4224`)
  under the **explicit `assumePeerless` escape hatch**, exercising the OPEN→IMPORT→VERIFY(across
  epochs)→TEARDOWN **logic**. The invariant itself is now carried by TWO in-process guarantees, not by the
  live run: the **type** (only a DMZ can import) and the **peerlessness assertion at open** (the DMZ can only
  import into a target that cannot propagate).
- **What changed the ask.** With the peerlessness assertion in place, **no new field is needed from Aegis** —
  `listRegistries()` already answers the question, and their peerless node already returns `["local"]`. The
  live cross-gatekeeper run's **remaining value is confirmation, not enforcement**: it confirms *the target
  is the node we think it is and behaves as expected end-to-end* — that node B really is peerless in
  practice, that a real import+verify+teardown round-trips, and that a resolve against node A finds nothing.
  It no longer *establishes* the invariant (the type + the open-time check do); it *witnesses* it once
  against real infrastructure.
- **What I'd need to run that confirmation:** a **host-reachable** endpoint for node B's **peerless,
  import-open** Gatekeeper (publish `:4224`, or run `e2e:dmz` *inside* the Aegis network — e.g. from
  `harness-hearthold-delivery.sh`), plus (if node B gates admin) its import key as `HEARTHOLD_DMZ_API_KEY`.
  Then run with `HEARTHOLD_DMZ_URL=http://<nodeB>:4224` — `e2e:dmz` interrogates it for real (no escape
  hatch) and the lifecycle runs against genuine peerless infrastructure.

## Test coverage

- `e2e:dmz` — the peerlessness decision logic (peerless accepted, peered/undetermined refused, escape hatch
  bypasses loudly); **PEERED-TARGET** (flaxlap) and **UNDETERMINED-TARGET** (unreachable) both refused with
  no session created; import; verify a VC chain and a payload proof; **verify across a key rotation**
  (pre-rotation VC still verifies); teardown leaves no residue and refuses further use; the structural B6 guard.
- `e2e:keep-closure` — goal-dependent, version-pinned minimal subgraphs; the weaker closure still proves its
  weaker claim; the issuer pinned to its signing version with later rotations excluded.
- `e2e:pvm-boundaries` — B6 now GREEN, structural + confined to `dmz.ts`.
- `e2e:credential-delivery` — the refactor: native accept on shared-registry; cross-node routes to the DMZ;
  no `importDIDs` into the node's own gatekeeper anywhere.

## Live confirmation — Path A + Path B, DONE (Aegis)

### Path A — the DMZ lifecycle against a real peerless node

Aegis ran `e2e:dmz` against a **genuinely peerless, mediator-less DMZ** they built (published on `:4260`,
own node at `:4324`; import was open — no admin key needed on a dev instance). All core invariants came back
**GREEN**: peerlessness interrogated with **no escape hatch**, import → verify-chain → verify-proof →
teardown (no residue) → fail-closed → B6 structural. So the invariant is now witnessed against real
separated infrastructure, not just the type + open-time check.

**One positive finding — the separation the shared-DB stand-in had been masking.** The rotation check
originally exported the issuer chain, then rotated on the **own** node, then expected the DMZ to report v2.
That only ever passed because flaxlap's shared-DB stand-in leaked the own-node rotation into the "DMZ."
Against a genuinely separate DMZ the rotation never reaches it — the DMZ correctly stays at v1, because **a
DMZ verifies exactly what is imported into it, never what the own node does afterwards.** That is precisely
the isolation B6 exists to prove; the stand-in was hiding it. Fixed: rotate **first**, then re-export and
import the two-epoch chain into the DMZ before `verifyChain` (the corrected test asserts the issuer chain
resolves to v2 *in the DMZ* and the VC signed by the retired key-1 still verifies against it). The corrected
test passes on the stand-in and against a real peerless DMZ alike, and no longer depends on any DB leak.

**Operational note (Aegis):** point `HEARTHOLD_DMZ_URL` at `127.0.0.1`, not `localhost` — the DMZ publishes
on IPv4 and `localhost` may resolve to `::1`. Aegis's transcript + `docs/CONTAINER-TOPOLOGY.md` + topology
profiles are committed on their side (`c6769acb`).

### Path B — the full cross-node B6 assertion, on separate gatekeepers (7/7)

The test the shared-DB stand-in structurally could not do: a **counterparty** (`warden@nodeA`) mints a
credential on **its own** node; the **subject** verifies it **inside the peerless DMZ**; and the subject's
own private node **never receives the ops** — verification without republication, on real separate
gatekeepers, fully offline. Aegis ran it live, 7/7:

```
== PRE: DMZ passes assertPeerlessTarget (registries=[local])                 PASS
== COUNTERPARTY (warden@nodeA) mints a credential on ITS node                PASS
== op chains exported (issuer, schema, credential)                          PASS
== SUBJECT verifies the counterparty credential INSIDE the DMZ
     DmzSession open against http://127.0.0.1:4260 (peerless accepted)
     verifyChain(vc)     in DMZ : true
     verifyChain(issuer) in DMZ : true
     session teardown: destroyed=true residue=0                             PASS
== THE ASSERTION — subject's OWN node never held the ops
     node B LOCAL db does NOT hold the VC (no republication)                PASS   ← closes B6
     counterparty node A DOES hold it (sanity)                             PASS
     ephemeral DMZ instance destroyed (down -v) → ops gone, fresh empty     PASS
RESULT: 7 passed, 0 failed
```

Two reproduction details Aegis flagged, worth capturing so nobody gets a false pass:

1. **Assert node B's LOCAL view, not a fallback resolve.** An ordinary `resolveDID(vc)` on node B would find
   the credential **via the peer-link fallback** (node A holds it) and report a false PASS. "Held /
   republished" means present in node B's **local op store** — so the assertion must query node B's
   *local-only* view, not its resolver (which is allowed to reach across the peer link for reads). Anyone
   reproducing this needs that distinction.
2. **Ephemeral teardown is genuinely two-part, and the split is exactly as designed.** `session.teardown()`
   destroys the *session* (Hearthold-side — `destroyed=true`, `residue=0`); destroying the *instance's data*
   is Aegis-owned (`docker compose down -v` on the DMZ profile). Aegis asserted **both**: the session is
   clean, and after `down -v` the imported ops are gone and a fresh instance comes up empty. The DMZ needed
   **no admin key** (import open on a dev instance — consistent with Path A).

Committed on the Aegis side (`499361…`: `two-node/dmz-path-b.sh` + the `DmzSession` glue).

**B6 is now closed three independent ways**, and all three hold: the **type** (capability confinement — only
a DMZ can import), the **open-time `listRegistries` check** (target isolation — the DMZ can only import into
a node that cannot propagate), and this **live cross-node run** (behavioural proof, on separate DBs, that the
subject's own node never held the counterparty's ops).

### Two-machine validation + deployment-layer seal (Aegis)

Aegis then ran it across **two physical machines** — `megaflax ↔ gamerflax` over Tailscale, two isolated
nodes, no shared registry — issuing and verifying a VC between them. Confirmation, not an ask; four points
worth recording:

- **Genuine cross-machine proof.** A counterparty on a *separate physical machine* issued a credential; the
  subject verified it inside the peerless DMZ and could hold it offline after the counterparty powered down —
  and B6's confinement + the keep-closure are what keep that from meaning "I now silently rebroadcast their
  identifiers." An operator, unprompted, re-derived the DMZ model verbatim ("inbound DIDs should land in the
  DMZ for observation before the private DB; keep only the VC-related ops, discard the rest on teardown") —
  the model is intuitive enough that a user reinvents it.
- **`exportDIDs` returns a SUPERSET — and `closure.ts` filters it.** Aegis requested 3 DIDs (issuer, schema,
  credential) and got back **4** chains: a referenced dependency (the issuer's node identity) rode in
  unrequested. Confirmed and hardened: the keep-closure is computed from the **requested** set, never the
  returned batch — `computeKeepClosure` keeps only the VC + schema + issuer-chain-to-the-signing-version
  (+ authority for the stronger goal), and `keptOps` now selects the requested DID's chain by its per-event
  `did` tag even if a single-DID export expands, failing closed otherwise. The extra dependency **stays in
  the DMZ and evaporates on teardown**; it never reaches Private. (`e2e:keep-closure` asserts exactly this:
  closure A excludes the charter and regulator, which *are* resolvable but unrequested.)
- **The fallback resolver does NOT cache (resolve-fresh is clean).** Aegis rechecked: `resolveFromUniversalResolver`
  (`gatekeeper-api.ts:777`) fetches a stripped triple and **stores nothing** — mere resolution is ephemeral
  and vindicates the resolve-fresh posture. The only pollution vector is **import-side** (a raw `dids/import`,
  or the export-expansion above), never resolution.
- **The type layer is sealed below by a network guard.** `PrivateGatekeeper` binds *Hearthold code*, but the
  raw `POST /api/v1/dids/import` HTTP endpoint sits beneath the type layer and a `curl` (or a malicious peer)
  can reach it. Aegis closed that at the **deployment layer** (`deploy/topology/{gatekeeper-guard.mjs,
  docker-compose.sealed.yml}`): a resolution-only guard fronts the gatekeeper and returns `403` for
  import/admin/enumerate/bulk-export — even with a valid admin key — while still serving the GET reads a
  peer's fallback needs. So both sides of the boundary are covered: **our type guarantee for Hearthold code,
  Aegis's network seal for everything below it.**
