# Deployment — the local-first standard model

This is Hearthold's **default** deployment, not a special case. A node runs **fully local**: its own
Gatekeeper + Keymaster + IPFS, a **unique per-node hyperswarm topic** as its registry, and nodes connect
**point-to-point over DIDComm** by exchanging DIDs out of band. **No internet is required** — the same
posture the isolated (Aegis) substrate proves, generalized. Cross-node credential delivery
([`credential-delivery/FINDINGS.md`](credential-delivery/FINDINGS.md)) and the partition ladder
([`partition-ladder/`](partition-ladder/)) both assume this model; `world-public` in the ladder means
"anyone I'm connected to," not "the public," precisely because there is **no publication step** here.

Name the trust assumptions in the same register as everything else — plainly, including the sharp edges.

## Gossip is transitive and unfiltered

A registry topic is an **epidemic, not a two-party exchange.** Every Gatekeeper on a topic gossips **all**
the DIDs it knows, and **re-gossips what it learns** from others. There is no selective sharing at this
layer — you cannot put one DID on a topic "just for" one peer. The **only** isolation mechanism is the
**topic boundary itself**: a unique per-node topic is what keeps a node's DIDs from spreading, and joining a
shared topic means accepting the full mutual epidemic. Choose topics accordingly; treat "who shares a topic"
as "who will hold and re-broadcast each other's DIDs."

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
