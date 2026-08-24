# Deployment — the local-first standard model

This is Hearthold's **default** deployment, not a special case. A node runs **fully local**: its own
Gatekeeper + Keymaster + IPFS, the **`local` registry** by default (or a **unique per-node hyperswarm
topic** when separate nodes must resolve each other — see *Two registry topologies* below), and nodes
connect **point-to-point over DIDComm** by exchanging DIDs out of band. **No internet is required** — the
same posture the isolated (Aegis) substrate proves, generalized. Cross-node credential delivery
([`credential-delivery/FINDINGS.md`](credential-delivery/FINDINGS.md)) and the partition ladder
([`partition-ladder/`](partition-ladder/)) both assume the multi-node case; `world-public` in the ladder
means "anyone I'm connected to," not "the public," precisely because there is **no publication step** here.

Name the trust assumptions in the same register as everything else — plainly, including the sharp edges.

## Two registry topologies — pick by node count, not by fear

Hearthold runs on one of two registries, and the choice is a **topology** decision, not a
security-vs-features tradeoff. Pick by how many gatekeeper nodes must resolve each other's DIDs:

| | `local` (default) | `hyperswarm` + unique topic |
|---|---|---|
| **When** | one gatekeeper node (all agents share it) | separate nodes must resolve each other (federation / multi-device delivery) |
| **Writes** | apply immediately (a DB row) | **queue** until `processEvents` drains them |
| **Reach** | node-local — never leaves the DB, unresolvable off-node | gossips to every peer on the topic |
| **Isolation** | **structural** at the registry layer (can't-**resolve** off-node by construction); full air-gap *also* needs the IPFS/Kubo node on an isolated swarm — the content layer (see below) | **conjunction** — safe only while `internal:true` **and** no mediator runs **and** the topic is a unique random string |
| **Cross-node** | impossible (that's the point) | the reason to choose it |

**`local` is the default** and the right choice for the common case: a single Archon node all four agents
(Warden / Emissary / Sovereign / Verifier) point at. Its **resolution** isolation is *structural* — a DID
write is a plain local DB row that no topic carries, so the DID cannot **resolve** on another node no matter
how the network is configured. Hearthold's flows work fully on `local` because `openKeymaster` sets
`ephemeralRegistry = config.registry` (`keymaster.ts`), so challenges / responses / credential-accept author
their ephemeral DIDs on `local` too — not the keymaster's hardcoded `hyperswarm` default that would bar a
`local` identity. The **entire e2e suite runs on `local`**.

#### `local` isolation is two layers — registry AND IPFS content (Aegis finding, 2026-07-28)

`registry=local` is necessary but **not sufficient** for an air-gap. Isolation has two independently-configured
layers, and `local` only guarantees the first:

| Layer | What it protects | Guaranteed by |
|---|---|---|
| Resolution / registry | the DID never gossips; won't **resolve** on other nodes | `registry=local` |
| **Content / bytes** | the DID create-op **bytes** never leave the host | the **IPFS (Kubo) node on an isolated swarm** |

A `local` DID minted on a node whose Kubo sits on the **public** IPFS swarm has its create-op content
content-addressed onto the global DHT — un-resolvable elsewhere (registry blocks that), but the **bytes are
advertised** to the public network (retrieval is slow and unreliable over libp2p, but the exposure is
architectural, not gated). So the earlier "cannot propagate regardless of network config" claim holds for
*resolution*, not for *content*.

A full-air-gap `local` deployment must lock **both** layers:
1. `HEARTHOLD_REGISTRY=local` (resolution), **and**
2. the node's Kubo on an `internal:true` docker network (or a private swarm key / no public bootstrap) so it
   has **0 public swarm peers** (content). This is **L6 / deployment** config, not a Hearthold env var.

**Verification (bake into any `setup.sh`):** after bring-up, `ipfs swarm peers` on the identity node must
return **0** — an unfakeable air-gap check (a node with no peers *cannot* fetch or serve an external CID).
Aegis's isolated KBs pass this (`aegis-ipfs-1`, `aegisb-ipfs-b-1`: `internal:true`, 0 peers); each agent stack
runs its own Kubo, so identity content never shares a daemon with a federation bridge.

**Minting rule — mint on the isolated KB, never through the federation node.** A hyperswarm **federation /
sphere bridge** node (e.g. `sphere-mega-ipfs-1`) runs its Kubo on the *public* IPFS swarm by design — that is
what lets it federate. Any DID whose create-op is written **through the bridge node's Kubo** is content-
addressed to the public DHT. So: **create Sovereign / identity DIDs on the isolated identity KB; use a
federation node only to bridge already-created DIDs**, never to mint them.

**`hyperswarm` + a unique `ARCHON_PROTOCOL` topic** is required only when **separate gatekeeper nodes must
resolve each other** — a member's Warden on one laptop delivering a card to a Sovereign on another (Aegis's
Tor onion mailbox). `local` cannot serve that: it is node-local, so node B has no way to resolve a DID that
lives only in node A's DB. On `hyperswarm` a DID write **queues** — it is not resolvable (its keyAgreement
key included, so a sender can't authcrypt) until `processEvents` runs; the transport now drains the queue
automatically after every publish on a non-`local` registry (`transport.ts`, `publishTo`). Isolation here is
a *conjunction* the deployment must hold — `internal:true` (no egress) **and** no mediator running (nothing
consumes the gossip queue) **and** a unique random topic (no shared channel even if a mediator appears). This
is **L6 / Aegis's domain**, and the gossip semantics in the rest of this doc all describe *this* case.

> The sections below — "gossip is transitive," "holding is republishing" — are the sharp edges of the
> **`hyperswarm`** topology (federation). On `local` there is no gossip to reason about at all; the only
> tradeoff is that nothing resolves off-node.

## Gossip is transitive and unfiltered

A registry topic is an **epidemic, not a two-party exchange.** Every Gatekeeper on a topic gossips **all**
the DIDs it knows, and **re-gossips what it learns** from others. There is no selective sharing at this
layer — you cannot put one DID on a topic "just for" one peer. The **only** isolation mechanism is the
**topic boundary itself**: a unique per-node topic is what keeps a node's DIDs from spreading, and joining a
shared topic means accepting the full mutual epidemic. Choose topics accordingly; treat "who shares a topic"
as "who will hold and re-broadcast each other's DIDs."

## Gossip carries identifiers; documents are served on request

What gossip actually spreads is **identifiers and their operation log** — the existence of a DID and the
`did:cid` operations that let a Gatekeeper reconstruct it. It does **not** push the reconstructed **document**
at you. Resolving a DID to its document (and dereferencing its data resource) is a **request served by a
node**: `GET /api/v1/did/:did` (version-pinnable — `versionTime`, `versionSequence`, `confirm`, `verify`)
and `/1.0/identifiers/{did}[/data]` (grounded in [`DRAWBRIDGE-GROUNDING.md`](DRAWBRIDGE-GROUNDING.md)).

The consequence is the load-bearing one: **serve-time authorization is the real access-control point.**
Because a document is handed over only when someone asks the holding node for it, the decision of *whether to
answer* — the release ladder, the recognition check, the pairwise-encryption of what's returned — is where
access is actually gated, not at some imagined "publish" boundary (there isn't one). "The gate code is in a
close-friend rung" is enforced when B is **asked**, by B's Warden, at serve time. Design accordingly: never
rely on a document being unreachable because it "wasn't published"; rely on the serve-time gate that decides
each request.

## Holding is republishing

Importing a foreign DID into the local Gatekeeper does **not** make a private copy — it makes this node a
**re-broadcaster** of that DID on whatever topics it gossips. That is a harm to the **counterparty**, not
just an exposure for us: their identity now propagates from a node they never authorized. This is the
structural reason the credential-delivery **cache rule** ships and imports only **immutable assets** (a VC,
its schema) and **never the issuer's Agent DID** — beyond staleness, importing the issuer would enlist this
node in republishing someone else's mutable identity. Import foreign DIDs deliberately and narrowly, and
know that "I imported it to resolve it once" and "I now rebroadcast it" are the same act.

## The optional read-only public gatekeeper is a confirmation oracle, not a lookup convenience

A node may optionally consult a read-only **public** gatekeeper as a peer fallback (Archon's
`resolveFromUniversalResolver`). Its role is **load-bearing for verification**, not merely lookup: it is the
**confirmation oracle** for any registry this node does not locally support. An **isolated node with no
peers cannot confirm anything outside its own registry** — it can hold a foreign DID's ops but has no
independent source to attest that state is real and current. Accepting that gatekeeper's confirmations is a
**trust dependency on whoever operates it**: a dishonest or stale oracle can withhold or misreport
confirmation. (It cannot, however, forge a credential — verifiers still check the *issuer's* signature, not
the oracle's word.) Decide consciously whose confirmation you accept; "we fall back to the public gatekeeper"
is a trust choice, not free infrastructure.

## "Nothing leaves the local DB" is true of content, not of interest

Querying the public gatekeeper (or any peer) reveals **which DIDs we're interested in** — that is
**metadata**, and it does leave the node. The honest statement is that **content** stays local: private
data, VC payloads, and the local DB are never shipped by resolution. It is **not** true that *nothing*
leaves — the set of DIDs you resolve, and their timing, is observable to whoever answers. State it at that
resolution and no broader: content stays home; interest does not.

## Where this bites, by feature

- **Credential delivery**: the cache rule (immutable-only, resolve issuer fresh) is a direct consequence of
  *holding is republishing* + mutable identities. The interim `includeIssuerOps` throwaway is exactly the
  act to minimize and retire (see [`credential-delivery/MACTERRA-ESCALATION.md`](credential-delivery/MACTERRA-ESCALATION.md)).
- **Partition ladder**: `world-public` reach = "connected peers," bounded by the topic/DIDComm connection
  set, never "the internet." An unranked tier reaches nothing at all.
- **Isolation (Aegis)**: the isolated two-node substrate is this model with the public-gatekeeper fallback
  removed and a private inter-node topic — so cross-node confirmation is *only* mutual, with no external
  oracle, by construction.
