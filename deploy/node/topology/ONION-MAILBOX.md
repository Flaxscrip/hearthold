# The onion-mailbox front door — "secure system with a mailbox open"

The recurring config: a node that stays **egress-sealed** by default, yet can expose a **DIDComm mailbox**
for delivery (a card from a peer, a credential, a message) — with **no inbound port** and **no tailnet
membership**. It has two parts:

1. **The canonical front (this is built).** The Hearthold-facing mailbox/resolve surface is the **Drawbridge**
   — never the raw relay (`:4236`), the raw gatekeeper (`:4224`), or a bespoke gateway. *(flaxscrip, 2026-07-27:
   "Drawbridge is the proper service name if we're going to expose a port with Hearthold.")*
2. **The reachability (this is the drawn "sword" — opt-in, gated).** A **Tor onion** fronts the Drawbridge.
   Publishing it requires giving **one** container — `tor` — a scoped egress leg. That is a deliberate posture
   change, off by default.

---

## Part 1 — Mailbox-only Drawbridge  ✅ DONE (gamerflax, 2026-07-27)

`deploy/topology/docker-compose.drawbridge-mailbox.yml` runs the **canonical** `ghcr.io/archetech/drawbridge`
as the front, **without** the payment rail (lightning-mediator) or herald/naming that the stock `drawbridge`
profile hard-depends on — the coupling that had made gamerflax reach for the `table-gateway` bypass.

```
docker compose -p aegis-mailbox -f deploy/topology/docker-compose.drawbridge-mailbox.yml up -d drawbridge
```

What it fronts (verified live on gamerflax, all from inside the sealed `archon_default`):

| Surface | Path | Result |
|---|---|---|
| Resolve (open) | `GET /api/v1/did/:did` | `200` |
| DIDComm mailbox | `POST /didcomm/api/v1/messages` | `400` "Not a DIDComm encrypted message" (= mailbox live) |
| Admin / import | `/api/v1/*` admin, `/dids/import` | **sealed** — the front injects NO admin key, by design |

Notes learned standing it up:
- `ARCHON_DRAWBRIDGE_MACAROON_SECRET` (32+ chars) is **boot-required** even with L402 unused (the newer
  drawbridge image enforces it; older arm64 images didn't). Set to a marked dev placeholder here.
- Lightning is **lazy** (`LightningUnavailableError` only on an L402 call) — safe to omit the mediator.
- Set `ARCHON_REDIS_URL` or ioredis hammers `localhost:6379`.
- **No host port** is published — the Drawbridge is reachable only on the internal net until the sword (Part 2)
  is drawn. The mailbox proxy is correct: `POST <drawbridge>/didcomm/api/v1/messages` → strips `/didcomm` →
  relay `/api/v1/messages`. The advertised endpoint is therefore `<host>/didcomm`; senders append
  `/api/v1/messages` (see the relay's own delivery code).

### `table-gateway`'s residual role (why it is NOT fully retired)
`table-gateway` did **two** jobs; only one was ever the Drawbridge's:
- **Mailbox/resolve front (a)** → now the **Drawbridge**. ✅
- **`HEARTHOLD_NODE_URL` = admin-keyed gatekeeper access (b)** — Hearthold's own create/import/processEvents
  need the gatekeeper **admin key injected**. A *public* front must never inject an admin key, so this stays a
  **narrow internal shim**, not an exposed port. Clean end-state: Hearthold wires a separate admin
  `GatekeeperClient.create({url, apiKey})` (coordination ask to Hearthold) — then `table-gateway` disappears.

So: the **exposed** DIDComm surface is the Drawbridge (principle satisfied); `table-gateway` survives only as
Hearthold's private admin backend until that Hearthold change lands. The advertised-endpoint cutover
(`HEARTHOLD_DIDCOMM_ENDPOINT` → `<drawbridge>/didcomm`, then → `<onion>/didcomm`) happens with Part 2, when an
external peer actually consumes it.

---

## Part 2 — The Tor "sword"  🔒 PLANNED, GATED on flaxscrip's explicit okay

**Posture, honestly:** the whole node is egress-sealed today (`archon_default` + `aegis-peer` both
`internal=true`; `aegis-tor-1` on megaflax is stuck at `Bootstrapped 0%` — the onion address is derived offline
and is **not** actually published). Opening the mailbox on Tor means **exactly one container (`tor`) gets a
scoped egress leg to the Tor network**. Nothing else egresses; no inbound port opens. That is the sword: sealed
in the sheath, reachable only when drawn.

```
   sealed node (internal:true)                         Tor network
   ┌───────────────────────────────┐
   │ gatekeeper · didcomm · draw-  │                       ▲ outbound only
   │ bridge     (NO egress)        │                       │ (rendezvous)
   │            ▲ archon_default   │                 ┌─────┴──────┐
   │            └──────────────────┼─────────────────┤    tor     │ ← ONLY egress
   └───────────────────────────────┘                 └────────────┘
      no inbound port anywhere            onion:4222 → drawbridge:4222 → /didcomm mailbox
```

**Draw it (steps):**
1. Give `tor` a **scoped egress leg** — attach it to a small non-`internal` DMZ network (or an equivalent
   egress-allowed leg) while it stays on `archon_default` to reach the drawbridge. `tor` becomes a deliberate,
   single straddler.
2. Bring up `tor` with `DRAWBRIDGE_TOR_SERVICE_HOSTS=4222:drawbridge:4222` (v3). Onion keys persist in the
   gitignored `data/tor-*/`.
3. Wait for `Bootstrapped 100%` (~30–60s) — only then is the onion actually published.
4. Publish the recipient Sovereign's DID with `serviceEndpoint = http://<onion>:4222/didcomm`
   (`HEARTHOLD_DIDCOMM_ENDPOINT`, then a keymaster publish — sovereigns currently advertise none).
5. The sender delivers through **its own** `tor:9050` SOCKS proxy — the relay/keymaster already dial `.onion`
   via `fetch-socks` (`ARCHON_DIDCOMM_TOR_PROXY=tor:9050`).

**Sheathe it (reversible):** detach the egress leg → tor drops to 0%, the onion goes dark, the node is fully
re-sealed. No data change.

**Sentinel gets a new posture — "onion-mailbox / DMZ":** egress is *expected*, but verify it is **Tor-only**
(no other container egresses; tor's leg reaches only the Tor network) and the **gatekeeper is still sealed**
behind the drawbridge. This is the L6 check that the drawn sword didn't cut wider than intended.

---

## Cross-node card pass (Sevenfold), once the sword is drawn on both nodes
- **gamerflax** (recipient): Drawbridge ✅ up; draw the tor sword → publish its Sovereign's `<onion>/didcomm`.
- **megaflax** (sender): already onion-capable; deliver the sealed card via `tor:9050` to gamerflax's onion.
- Result: a **sealed card crossing two laptops, no tailnet, no inbound port**. Arrives born-obsidian until
  Hearthold ships `POST /api/card/accept` (the flip-into-vault step — separate, doesn't block arrival).
- gamerflax Sovereign toDid: `did:cid:bagaaiera3vee5dzkgp776cpnuhpcqjd2u7ihit2dv6kjfqbvcnevrvbd6xpa`.
