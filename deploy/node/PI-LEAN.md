# pi-lean — the 8 GB Sovereign profile

The default "isolated node" profile (`COMPOSE_PROFILES=cli,didcomm,drawbridge`, what `setup-node.sh` sets today)
is **not** lean. Archon's **`drawbridge` profile is coupled to Lightning + Tor by design**: the `drawbridge`
service hard-`depends_on: tor` and `lightning-mediator`, and the Lightning fragment tags `cln · lnbits · rtl ·
rtl-init · lnbits-init` with `profiles: ["lightning", "drawbridge"]`. So enabling `drawbridge` drags in the whole
value rail + Tor + Herald — ~850 MB the node doesn't need to pass a card.

**pi-lean sheds that.** The `didcomm` relay (`:4236`) is standalone — it depends only on the gatekeeper + redis,
serves the mailbox itself, and is what drawbridge proxies anyway. So a sovereign identity + card-passing node needs
**no drawbridge, no Lightning, no Tor, no Herald.**

## The profile
```
COMPOSE_PROFILES=cli,didcomm          # NOT drawbridge
ARCHON_GATEKEEPER_REGISTRIES=local    # local registry only — no hyperswarm gossip
ARCHON_DEFAULT_REGISTRY=local
ARCHON_GATEKEEPER_FALLBACK_URL=       # no external resolver fallback (sealed)
ARCHON_GATEKEEPER_CONFIRM_FALLBACK_URL=
```

## What runs (and what doesn't)

| layer | pi-lean (always) | opt-in / dropped |
|---|---|---|
| **core** | `mongodb` · `redis` · `ipfs` · `gatekeeper` · `keymaster` | — |
| **identity/cards** | `cli` · `didcomm` (:4236 mailbox relay) | ~~`drawbridge`~~ (pulls lightning+tor) |
| **value rail** | — | `lightning` (`cln`·`lnbits`·`rtl`·`lightning-mediator`) — opt-in for spend demos |
| **transport** | — | `tor` (onion mailbox) · `herald` (hyperswarm gossip) |
| **UIs / chains** | — | `explorer` · `react-wallet` · `observability` · `btc-*` · `pinning` |
| **custodian** (hearthold) | Warden · Signet · Emissary consoles | image-Emissary (drop for leanest) |
| **on-device AI** | `ollama` + **one** model (classifier), `MAX_LOADED_MODELS=1` | vision model (co-load = OOM) |

**Card-passing note:** the custodian's DIDComm endpoint points at the relay directly —
`HEARTHOLD_DIDCOMM_ENDPOINT=http://didcomm:4236` (not `drawbridge:4222/didcomm`). Node URL for keymaster DIDComm
ops stays the in-network gatekeeper / write-proxy as usual.

## Memory budget (measured at idle on reference hw; classifier loaded)
```
OS + Docker overhead        ~1.0 GiB
core substrate (5 svcs)     ~0.4 GiB   (mongo 142 · gatekeeper 128 · didcomm 99 · keymaster 75 · redis 20 · ipfs 40)
custodian control plane     ~0.3 GiB
ollama + qwen2.5:3b         ~2.5 GiB   ← the dominant variable
AI family (3 agents, opt.)  ~0.5 GiB
                            ─────────
                            ~4.3–4.8 GiB   ✅ fits 8 GB with headroom
```
Versus the current `…,drawbridge` default that also carries Lightning (~750 MB) + Tor (~95 MB) + Herald — the whole
point of pi-lean is to not hold those at rest. `lightning`/`tor` become opt-in overlays for when you actually want a
spend demo or an onion mailbox.

## ⚠️ Validate on the Pi (the one open question)
The custodian wardens have only ever run DIDComm against `drawbridge:4222/didcomm` / `table-gateway:4299`. pi-lean
points them at the relay directly (`didcomm:4236`). **Confirm the keymaster's DIDComm challenge/fetch works against
the relay with no drawbridge** (tonight's `gateway challenge request returned 404` was the *raw gatekeeper*, not the
relay — the relay is the actual mailbox, so this should hold, but it's the thing to prove first). If it doesn't, the
fallback is a small overlay that runs a *lean* drawbridge (its `depends_on: tor/lightning-mediator` removed, those
services re-tagged out of the `drawbridge` profile) — heavier to maintain, so didcomm-direct is preferred.

## Connecting out — the public gatekeeper (optional, NOT the pi-lean default)
pi-lean runs **isolated**: local registry, no fallback resolver, no egress. But when you *deliberately* want to
resolve a public DID or peer with another node, **`https://archon.technology/api/v1`** is our public gatekeeper —
a live Archon **v0.11.0** drawbridge (`/api/v1/ready` → `true`; ~10.9k DIDs). It is also the delegation target for a
connected (non-isolated) noderunner. Leave it OUT of the sealed node's config (isolation is the point); reach for it
only as an explicit, controlled connection — the same way we'll peer to `flaxscrip.local`'s full node.
