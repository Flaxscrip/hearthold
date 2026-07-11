# Deploying the DIDComm relay for Hearthold (clearnet + `.onion`)

**Purpose:** give Hearthold agents (the home **Warden**, the **A2A gateway**) a reachable DIDComm v2
endpoint so the CGPR relay path (`e2e:cgpr-relay`, `didCommCgprBackend`) works cross-host, and prefer a
`.onion` endpoint so the DID's published transport doesn't leak the recipient's network location.

**Nothing changes in Hearthold.** `DidCommTransport.ready()` publishes whatever the node returns from
`GET <nodeUrl>/api/v1/didcomm-endpoint`. Clearnet or onion is a **node config** choice.

Handoff target: the agent managing **archon.social** (and archon.technology). All settings below are on the
**Archon node**, not in this repo.

## How the relay works (why the home Warden needs no inbound port)

The DIDComm relay (`services/didcomm`, port `4236`) is a **store-and-forward mailbox**: senders `POST` an
encrypted envelope; the relay files one copy per recipient DID and holds it; the recipient **polls** and
fetches its own mail after a single-use signed challenge. The relay holds no keys and cannot read
envelopes. So a **home-bound Warden behind a firewall works fine** — it never accepts inbound connections;
it polls the relay. The *relay* is the public part.

**Drawbridge** (port `4222`, the node URL Hearthold points at) reverse-proxies `/didcomm/*` → the relay
(not paywalled), and exposes `GET /api/v1/didcomm-endpoint` for `publishDidComm` auto-discovery.

## What to enable

Add the `didcomm` profile (Drawbridge is presumably already on for Lightning). In the node's `.env`:

```dotenv
# Bring up the DIDComm relay alongside whatever is already running (drawbridge brings Tor + the /didcomm proxy).
COMPOSE_PROFILES=hyperswarm,drawbridge,didcomm      # + your existing profiles (lightning, etc.)

# --- DIDComm relay (services/didcomm) ---
ARCHON_DIDCOMM_PORT=4236
ARCHON_DIDCOMM_DB=redis                 # persistent mailboxes (default is in-memory — lost on restart)
ARCHON_DIDCOMM_MESSAGE_TTL_MS=604800000 # 7 days: a home Warden that polls infrequently must not miss mail
ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS=false   # prod: relay refuses delivery to private/loopback/LAN targets
ARCHON_DIDCOMM_TOR_PROXY=socks5h://tor:9050 # so the relay can DELIVER to recipients whose endpoint is .onion
```

## Choose the published endpoint (this is the privacy lever)

`GET /api/v1/didcomm-endpoint` resolves, in order:

1. `<ARCHON_DRAWBRIDGE_PUBLIC_HOST>/didcomm` — if `ARCHON_DRAWBRIDGE_PUBLIC_HOST` is set;
2. else `http://<tor-onion>:<port>/didcomm` — the node's Tor hidden-service hostname;
3. else `null` (DIDComm effectively off for auto-discovery).

So:

- **`.onion` (recommended for the sovereign/internal mesh):** **leave `ARCHON_DRAWBRIDGE_PUBLIC_HOST` unset**
  and run Drawbridge's Tor hidden service (already on for Lightning). Published endpoint becomes
  `http://<onion>/didcomm` — the recipient's network location is hidden; observers see neither the host nor
  the content. This is the on-thesis default for Hearthold. Cost: senders must reach Tor.
- **Clearnet (for interop with non-Tor peers):** set `ARCHON_DRAWBRIDGE_PUBLIC_HOST=https://archon.social`
  → `https://archon.social/didcomm`. Reachable by anyone, but the endpoint publicly ties a DID to this host.
- **Note on "dual":** the node advertises **one** DIDComm endpoint. The A2A *edge* is separate — that stays
  **clearnet HTTPS** (Hearthold's own gateway, so a clearnet hotel AI can reach it); only the internal
  gateway↔Warden and sovereign-to-sovereign **DIDComm** hop rides `.onion`. A DID *could* carry two
  `DIDCommMessaging` services (clearnet + onion) for peer choice — that's a Hearthold/keymaster enhancement,
  not needed for v1.

## Verify (the managing agent runs these)

```bash
# 1. The node advertises a DIDComm endpoint (not null):
curl -s https://archon.social/api/v1/didcomm-endpoint         # → { "endpoint": "http://<onion>/didcomm" } or "…/didcomm"

# 2. The relay answers through Drawbridge's proxy (a malformed body is the expected 400 — proves it's mounted):
curl -s -X POST https://archon.social/didcomm/api/v1/messages -d '{}'   # → 400 { "error": "..." }  (501 if DIDComm disabled)
```

Then, Hearthold-side (us), the first live cross-host round-trip:

```bash
# Point a Warden + gateway at archon.social instead of flaxlap and run the relay e2e.
HEARTHOLD_NODE_URL=https://archon.social HEARTHOLD_DATA_ROOT=$(mktemp -d) npm run e2e:cgpr-relay
```

For a `.onion` node URL, the Hearthold client itself needs a Tor route (a local SOCKS proxy, or keep the
*node URL* clearnet Drawbridge while only the *published recipient endpoints* are onion). Confirm which the
node exposes before wiring the client.

## Privacy summary

The relay sees **recipient DIDs + timing, never content** (envelopes are encrypted to the recipient). A
`.onion` endpoint additionally hides **which host serves a DID** and resists network-layer correlation —
consistent with Hearthold's pairwise-DID / no-registry-footprint posture. DIDComm's async
poll-and-forward design tolerates Tor latency well (a message just waits in the mailbox), so onion delivery
is reliable in a way a synchronous API would not be.

## Handoff checklist (archon.social managing agent)

- [ ] Add `didcomm` to `COMPOSE_PROFILES`; set the `ARCHON_DIDCOMM_*` knobs above; `docker compose up -d`.
- [ ] Decide the endpoint mode: **onion** (leave `ARCHON_DRAWBRIDGE_PUBLIC_HOST` unset) or **clearnet** (set it).
- [ ] If any recipients use `.onion`, set `ARCHON_DIDCOMM_TOR_PROXY` so the relay can deliver over Tor.
- [ ] Verify with the two `curl`s above; report back the resolved endpoint.
- [ ] (Us) run `e2e:cgpr-relay` against archon.social for the first live cross-host CGPR grant.
```
