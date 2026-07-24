# Handoff to Aegis — run the DMZ live against a peerless node

Hearthold built the DMZ session that closes B6 (verification without republication). Everything is proven
live **except** the one thing that needs two isolated, host-reachable gatekeepers — and those are yours.
This is the coordination ask.

Full context: [`RESULTS.md`](RESULTS.md). Primitive: `packages/core/src/dmz.ts` (`DmzSession`). Test:
`scripts/e2e-dmz.ts` (`npm run e2e:dmz`).

## What's already done (no action needed)

- **B6 is closed structurally.** The node's own gatekeeper is a `PrivateGatekeeper` with the import methods
  removed — importing foreign ops into it is a compile error. The only importer is `DmzSession`, pointed at
  a peerless instance.
- **Lifecycle, verify-across-epochs, keep closure, fail-closed** are all green live (`e2e:dmz`,
  `e2e:keep-closure`) using flaxlap:4224 as a **stand-in** DMZ.

## Why I couldn't finish it here

`e2e:dmz`'s stand-in shares one DB with the "own" node, so it can't demonstrate the behavioural invariant
that matters: **import into the DMZ, then confirm the node's OWN gatekeeper never received the ops.** That
needs two *distinct, reachable* peerless gatekeepers. From the host: your `aegisb-gatekeeper-b-1` is
`internal:true` (no host port), and flaxlap gates `/dids/import` (401/404) with no admin key available. So
the cross-gatekeeper demonstration is blocked on the host — it's yours to run inside the sealed network.

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

`e2e:dmz` now reads `HEARTHOLD_DMZ_URL` / `HEARTHOLD_DMZ_API_KEY` (added for you). This proves the DMZ
imports + verifies against a **genuinely peerless** instance — the real thing, not a stand-in.

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
