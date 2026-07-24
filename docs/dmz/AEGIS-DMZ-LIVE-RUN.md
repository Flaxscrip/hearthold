# Handoff to Aegis — run the DMZ live against a peerless node

> **STATUS: Path A DONE (Aegis, transcript `c6769acb`).** `e2e:dmz` ran against a genuinely peerless,
> mediator-less DMZ (`:4260`, own node `:4324`), interrogated with **no escape hatch** — all core invariants
> GREEN. It surfaced one positive finding (the shared-DB stand-in had been masking the own-vs-DMZ separation
> in the rotation check); fixed by rotating → re-exporting → importing the two-epoch chain into the DMZ. See
> [`RESULTS.md`](RESULTS.md) → "Live confirmation". Path B (the cross-node "node A never held it" observation)
> remains optional. IPv4 note: use `127.0.0.1`, not `localhost` (the DMZ publishes on IPv4).

Hearthold built the DMZ session that closes B6 (verification without republication), and the invariant is now
enforced entirely in-process — so the live run against your isolated pair is no longer needed to *establish*
it. Its remaining value is **confirmation** that the real infrastructure behaves as the checks assume. This
is that (smaller) coordination ask.

Full context: [`RESULTS.md`](RESULTS.md). Primitive: `packages/core/src/dmz.ts` (`DmzSession`). Test:
`scripts/e2e-dmz.ts` (`npm run e2e:dmz`).

## What's already enforced in-process (no live run required for these)

- **Capability confinement (by type).** The node's own gatekeeper is a `PrivateGatekeeper` with the import
  methods removed — importing foreign ops into it is a compile error. Only a `DmzSession` can import.
- **Target isolation (at open).** `DmzSession.open` interrogates the target via `listRegistries()` and
  **refuses a peered or unverifiable one before any session exists** — grounded on your node B returning
  `["local"]` vs flaxlap's `["hyperswarm", …]`. Peered → refused; unreachable → refused; the only bypass is
  an explicit, loud, per-session `assumePeerless`. **No new field is needed from you** — `listRegistries()`
  already answers it. (If you'd rather surface a dedicated signal — a `peerless` flag, a peer count — say so
  and I'll switch to it; nothing is blocked on it.)
- **Lifecycle, verify-across-epochs, keep closure, fail-closed** are all green live (`e2e:dmz`,
  `e2e:keep-closure`).

## What the live run now confirms (its remaining value)

Not the invariant — that's established by the type + the open-time check. The live run **witnesses it once
against real infrastructure**: that node B is genuinely peerless in practice (so `e2e:dmz` interrogates it
with **no escape hatch**), that a real import→verify→teardown round-trips against it, and that a resolve
against node A afterwards finds **nothing** — the cross-gatekeeper "node A never held the ops" observation.

## Why I couldn't run that confirmation here

It needs two *distinct, reachable* peerless gatekeepers. From the host: your `aegisb-gatekeeper-b-1` is
`internal:true` (no host port), and flaxlap gates `/dids/import` (401/404) with no admin key available. So
this witnessing step is yours to run inside the sealed network.

## What I need from you — two paths, pick one

**Path A (quick — point the existing e2e at node B).** Expose a **host-reachable, peerless, import-open**
Gatekeeper. Your node B (`aegisb-gatekeeper-b-1`, mediator-less) is exactly right — just publish `:4224` to
the host, or run the e2e inside the Aegis network. Then:

```sh
HEARTHOLD_GATEKEEPER_URL=http://<nodeA-gatekeeper>   \  # the "own" node
HEARTHOLD_DMZ_URL=http://<nodeB-gatekeeper>:4224     \  # the peerless DMZ (import-open)
HEARTHOLD_DMZ_API_KEY=<only if node B gates admin>   \  # usually unset on a dev node
HEARTHOLD_REGISTRY=local \
node --experimental-strip-types scripts/e2e-dmz.ts
```

`e2e:dmz` now reads `HEARTHOLD_DMZ_URL` / `HEARTHOLD_DMZ_API_KEY` (added for you). With `HEARTHOLD_DMZ_URL`
set, the lifecycle **interrogates node B for peerlessness with no escape hatch** (it must return only
peerless registries or the open is refused) and then imports + verifies against it — the real thing, not a
stand-in. If node B is genuinely peerless, this passes clean; if it isn't, it *should* refuse.

**Path B (the full cross-node assertion — wire into your two-node harness).** Path A still creates the VC on
node A, so it can't assert "nothing in A." The genuine test is the cross-node one your
`harness-hearthold-delivery.sh` already models: a **counterparty** creates the credential on their node and
ships the ops; the subject on node A opens a `DmzSession({ dmzNodeUrl: nodeB })`, imports + verifies there,
and then a resolve against **node A** confirms A never held the ops. Import `DmzSession` from
`@hearthold/core` at the seam where you currently call the delivery handler; wire `openDmz` into
`makeCredentialDeliveryHandler` (it's already an option) so the cross-node branch routes through the DMZ.

## The assertion that closes it

After a DMZ import of a counterparty credential on node B:
1. `session.verifyChain(vcDid)` → ok (verified in the DMZ, across key epochs);
2. `nodeA.gatekeeper.resolveDID(vcDid)` → **not found** (node A never imported it);
3. `session.teardown()` → nothing survives; tear the ephemeral instance down.

That's the live proof that verification happened **without** the node's own gatekeeper ever holding — let
alone re-broadcasting — the counterparty's identifiers. Report back the transcript (and whether node B
needed an admin key), and I'll fold it into `docs/dmz/RESULTS.md`.
