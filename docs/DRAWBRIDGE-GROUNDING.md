# Drawbridge grounding, then the DMZ

Five Drawbridge findings, checked against a live node (`flaxlap.local:4222` /
`:4224`) and the Archon source at `/Users/flaxscrip/archon`. One came back
overstated — flagged loudly below, not buried. The second half designs the
**DMZ** (an ephemeral verification environment for counterparty credentials),
**sphere-selection safety** (per-call publish targeting), and **DID↔swarm-key
binding** — design only, nothing built, nothing imported into any real
Gatekeeper.

## Grounded findings (E.1)

### 1. `createAuthMiddleware` wraps every Gatekeeper route

**Verdict: PARTIALLY GROUNDED — the "every route" part is FALSE.**

`createAuthMiddleware` is real, and it is DID-aware — but it is a **Drawbridge**
middleware (the proxy in front of the Gatekeeper, per this repo's own
`CLAUDE.md`: "Drawbridge on `:4222`... fronts the gatekeeper API... not the raw
gatekeeper on `:4224`"), not something inside the Gatekeeper server itself, and
it is **not** mounted on every route that talks to the Gatekeeper.

```
/Users/flaxscrip/archon/services/drawbridge/server/src/middleware/auth.ts:18
export function createAuthMiddleware(l402Options: L402Options): RequestHandler[] {
    return [
        createSubscriptionMiddleware(),
        createL402Middleware(l402Options),
    ];
}
```

It IS spread onto the DID/IPFS/search/block CRUD routes in
`drawbridge-api.ts:486-693` (`/registries`, `/did`, `/did/generate`,
`/did/:did`, `/dids`, `/dids/export`, `/ipfs/*`, `/block/*`, `/search`,
`/query` — all `...authMiddleware`).

It is explicitly **absent** from:

- `/ready`, `/version`, `/capabilities`, `/didcomm-endpoint`, `/status`
  (`drawbridge-api.ts:417-464`, no middleware in the handler chain at all)
- `/l402/*` (its own `requireAdminKey` gate, not `authMiddleware`)
- `/lightning` (`drawbridge-api.ts:697-708`, proxied with no `authMiddleware`)
- `/invoice/:did` (`drawbridge-api.ts:710-722`, comment: "Public invoice
  endpoint — no auth required")
- `/.well-known`, `/names` (Herald proxy, no `authMiddleware`)
- `/didcomm` (`drawbridge-api.ts:750-761`, no `authMiddleware` — see finding 3)
- `/1.0/identifiers` (`drawbridge-api.ts:763-775`, comment: "Intentionally
  open (no L402)" — see finding 5)

And even where `authMiddleware` **is** mounted, the L402 layer itself carves
out further exceptions — `isProtectedRoute()` in
`middleware/l402-auth.ts:31-42`:

```
const UNPROTECTED_PATHS = ['/ready', '/version', '/status', '/metrics', '/capabilities', '/didcomm-endpoint'];
const UNPROTECTED_PREFIXES = ['/l402/'];
const UNPROTECTED_GET_PREFIXES = ['/did/', '/ipfs/'];
```

So `GET /api/v1/did/:did` is mounted with `...authMiddleware` in the router
(`drawbridge-api.ts:516`), but L402 itself treats GET reads under `/did/` and
`/ipfs/` as unprotected — confirmed live: the curls in finding 2 below all
succeeded with **no** `Authorization` header and no 402 challenge.

**The DID-aware part is grounded.** The `did_known` label is real, on
`l402ChallengesTotal` (`drawbridge-api.ts:36-40`), and it is populated from
whether an `X-DID` request header was present when a 402 challenge was issued:

```
/Users/flaxscrip/archon/services/drawbridge/server/src/middleware/l402-auth.ts:196
    const did = req.headers['x-did'] as string | undefined;
...
/Users/flaxscrip/archon/services/drawbridge/server/src/drawbridge-api.ts:400
    onChallenge: (didKnown) => l402ChallengesTotal.inc({ did_known: String(didKnown) }),
```

**Read this precisely**: "the layer is already DID-aware" is true of the L402
challenge/macaroon layer (it caveat-binds a macaroon to a presented DID and
labels its own challenge metric by DID presence). It is not true that this
layer, or any auth layer, wraps "every Gatekeeper route" — three surfaces
that talk to the Gatekeeper (`/1.0/identifiers`, `/didcomm`, and GET reads of
`/did/` and `/ipfs/`) are deliberately open by design, confirmed both in
source comments and live curls with no auth header.

### 2. `GET /api/v1/did/:did` accepts `versionTime`, `versionSequence`, `confirm`, `verify`

**Verdict: GROUNDED.**

Source, Drawbridge proxy:

```
/Users/flaxscrip/archon/services/drawbridge/server/src/drawbridge-api.ts:516-530
v1router.get('/did/:did', ...authMiddleware, async (req, res) => {
    const options: any = {};
    if (req.query.versionTime) options.versionTime = req.query.versionTime;
    if (req.query.versionSequence) options.versionSequence = Number(req.query.versionSequence);
    if (req.query.confirm) options.confirm = req.query.confirm === 'true';
    if (req.query.verify) options.verify = req.query.verify === 'true';
    const result = await gatekeeper.resolveDID(req.params.did as string, ...);
```

Source, Gatekeeper implementation (same four options, destructured):

```
/Users/flaxscrip/archon/packages/gatekeeper/src/gatekeeper.ts:686
    const { versionTime, versionSequence, confirm = false, verify = false } = options || {};
```

Live, against a real DID pulled from the node's own `/api/v1/dids` list
(`did:cid:bagaaieravujsiuuzd4oxbdsjbw5hark652rx3egnpayd23y2eusnsmvjgnya`, a
9-version agent DID):

```
$ curl -s "http://flaxlap.local:4222/api/v1/did/$DID?versionSequence=1"
{"didDocument":{...},"didDocumentMetadata":{"created":"2026-02-17T02:26:21Z",
 "versionId":"bagaaieravujsiuuzd4oxbdsjbw5hark652rx3egnpayd23y2eusnsmvjgnya",
 "versionSequence":"1","confirmed":true},"didDocumentData":{}, ...}

$ curl -s "http://flaxlap.local:4222/api/v1/did/$DID"                       # no params → latest
{"...","didDocumentMetadata":{"...","versionSequence":"9",...},
 "didDocumentData":{"node":{"name":"flaxscrip:bombadil", ...}}}

$ curl -s -o /dev/null -w "%{http_code}\n" \
  "http://flaxlap.local:4222/api/v1/did/$DID?confirm=true&verify=true"
200

$ curl -s -o /dev/null -w "%{http_code}\n" \
  "http://flaxlap.local:4222/api/v1/did/$DID?versionTime=2026-01-01T00:00:00Z"
200
```

`versionSequence=1` returns genuinely different data (empty `didDocumentData`,
version-1 metadata) than the unparented call (version 9, populated data) —
this is real version-pinned resolution, not a param the server silently
ignores.

### 3. `/didcomm` is the relay/mailbox; `/api/v1/didcomm-endpoint` auto-discovery; Tor onion fallback

**Verdict: GROUNDED.**

The mailbox framing is a source comment, not paraphrase:

```
/Users/flaxscrip/archon/services/drawbridge/server/src/drawbridge-api.ts:746-748
// Public face for the DIDComm relay (mailbox). The published
// DIDCommMessaging endpoint is `<drawbridge public host>/didcomm`.
app.use('/didcomm', async (req, res) => { ... proxyRequest(req, res, config.didcommURL, '/didcomm') ... });
```

`GET /api/v1/didcomm-endpoint`:

```
/Users/flaxscrip/archon/services/drawbridge/server/src/drawbridge-api.ts:447-449
v1router.get('/didcomm-endpoint', async (_req, res) => {
    res.json({ endpoint: await resolveDidCommEndpoint() });
});
```

Tor onion fallback, `resolveDidCommEndpoint()`:

```
/Users/flaxscrip/archon/services/drawbridge/server/src/drawbridge-api.ts:73-92
async function resolveDidCommEndpoint(): Promise<string | null> {
    if (cachedDidCommEndpoint) return cachedDidCommEndpoint;
    if (config.publicHost) { ... return `${config.publicHost}/didcomm`; }
    try {
        const onion = (await readFile(config.torHostnameFile, 'utf-8')).trim();
        if (onion) { ... return `http://${onion}:${config.port}/didcomm`; }
    } catch { /* Tor hostname not published yet — retry on a later request. */ }
    return null;
}
```

Live:

```
$ curl -s http://flaxlap.local:4222/api/v1/didcomm-endpoint
{"endpoint":"http://flaxlap.local:4222/didcomm"}

$ curl -s http://flaxlap.local:4222/didcomm/health
{"ready":true}
```

flaxlap has `config.publicHost` set, so it returns the plain host, not the
onion — the onion branch is grounded in source but not exercised live here
(this node isn't in the Tor-fallback state). That specific sub-branch is
source-grounded, not independently live-verified.

### 4. `POST /api/v1/dids/export` exists

**Verdict: GROUNDED.**

Three layers, all confirmed:

```
/Users/flaxscrip/archon/services/drawbridge/server/src/drawbridge-api.ts:542-550   (Drawbridge proxy, wrapped in ...authMiddleware but see finding 1's GET-only carve-out — this is POST, so it IS gated by L402 in principle)
/Users/flaxscrip/archon/services/gatekeeper/server/src/gatekeeper-api.ts:1051-1058  (raw gatekeeper route, no requireAdminKey — contrast with /dids/import, which IS admin-gated per docs/credential-delivery/FINDINGS.md)
/Users/flaxscrip/archon/packages/gatekeeper/src/gatekeeper.ts:981-997               (impl: exportDID(did) = this.db.getEvents(did); exportDIDs loops exportDID per did)
```

Live, exporting the same 9-version DID:

```
$ curl -s -X POST http://flaxlap.local:4222/api/v1/dids/export \
    -H "Content-Type: application/json" -d '{"dids":["'"$DID"'"]}' | wc -c
17296
```

200 OK, no auth header sent, 17KB response — a full operation array (see the
export-history question in the DMZ section below, which inspects this exact
payload op-by-op).

### 5. `/1.0/identifiers` is proxied verbatim and NOT L402-gated

**Verdict: GROUNDED.**

```
/Users/flaxscrip/archon/services/drawbridge/server/src/drawbridge-api.ts:763-775
// Standards-conformant DID resolution / dereferencing surface (Universal Resolver
// driver convention). Proxied verbatim to the gatekeeper so its conformant output —
// the resolution triple, raw dereferenced resources, and status/error shapes — is
// preserved unchanged. Intentionally open (no L402): public DID resolution for interop
// with universal resolvers, which do not speak L402.
app.use('/1.0/identifiers', async (req, res) => {
    await proxyRequest(req, res, config.gatekeeperURL, '');
});
```

Live, unauthenticated:

```
$ curl -s -o /dev/null -w "%{http_code}\n" "http://flaxlap.local:4222/1.0/identifiers/$DID"
200
$ curl -s "http://flaxlap.local:4222/1.0/identifiers/$DID"
{"didDocument":{...},"didResolutionMetadata":{"contentType":"application/did+ld+json"},
 "didDocumentMetadata":{"created":"2026-02-17T02:26:21Z","updated":"2026-02-24T16:58:38Z",
 "versionId":"bagaaieraopgyxryg7b7mvv7waxbla5wn4iohrckvxbkj66b4qf5lqhfmg7pq","versionSequence":"9"}}
```

Note this is the **conformant** triple — no `didDocumentData`, no
`didDocumentRegistration` (those live at `/1.0/identifiers/{did}/data` and
`/.../registration`, per `identifiers-router.ts:65-232`). `/1.0/identifiers`
being unauthenticated does not mean private content leaks through it — it
returns the same public-document shape whether or not you'd have paid L402 for
the `/api/v1` equivalent.

## The DMZ — verification without republication (E.2)

### The rationale, confirmed against source

The premise is: the Gatekeeper stores did:cid **operations** (a hash-linked
create + update chain), not documents, and rebuilds the document by replaying
that chain on every resolve. Confirmed:

```
/Users/flaxscrip/archon/packages/gatekeeper/src/gatekeeper.ts:698
    const events = await this.db.getEvents(did);
...
/Users/flaxscrip/archon/packages/gatekeeper/src/gatekeeper.ts:710-728
    const anchor = events[0];
    let doc = await this.generateDoc(anchor.operation, did);
    ...
    for (const { time, operation, registry, registration: blockchain } of events) {
        // replays each operation onto doc, in order
```

So importing a counterparty's operations into our own Gatekeeper's DB makes
**us** capable of independently reconstructing (and, if we had a mediator,
re-broadcasting) their DID's state — we'd hold the same replayable chain they
do. The rationale that "a Gatekeeper with no Hyperswarm mediator has nothing
to propagate through" is grounded by what the mediator actually does — it's
the only thing in the codebase that pushes operations onto the wire:

```
/Users/flaxscrip/archon/services/mediators/hyperswarm/src/hyperswarm-mediator.ts:355-393  (shareDb: exports this node's DIDs, "hyperswarm distributes only operations")
/Users/flaxscrip/archon/services/mediators/hyperswarm/src/hyperswarm-mediator.ts:396-419  (relayMsg: forwards a received message to every other connected peer)
```

`resolveDID` (`gatekeeper.ts:682-728`) never touches the mediator, the swarm,
or the network — it is pure DB read + local replay. So a Gatekeeper process
with the hyperswarm-mediator container simply not running can hold, resolve,
and cryptographically verify imported operations with **zero** capability to
push them onward — there's no code path from "operation is in the DB" to
"operation left this box" except through that specific mediator process.

### Aegis's mediator-less Gatekeeper container profile — found

Two levels, both real, neither duplicated here:

**Single-node "sandbox" profile** —
`/Users/flaxscrip/isolation/aegis/SANDBOX-PROFILE.md`. `COMPOSE_PROFILES=cli`
in `.env` — "Only the containerized CLI on top of the always-on core services
(mongodb, redis, ipfs, gatekeeper, keymaster — these are not profile-gated at
all... No hyperswarm, no chain mediators, no Lightning/Drawbridge.)"
(`SANDBOX-PROFILE.md:59-63`). Registry forced to `local`
(`ARCHON_GATEKEEPER_REGISTRIES=local`, `ARCHON_DEFAULT_REGISTRY=local`,
`SANDBOX-PROFILE.md:69-70`). Network egress is separately cut with
`docker-compose.override.yml` (`networks.default.internal: true`,
`SANDBOX-PROFILE.md:95-99`). Invocation, verbatim from the doc:

```bash
cp sample.env .env             # then edit per SANDBOX-PROFILE.md §2
mkdir -p data
export GIT_COMMIT=$(git rev-parse --short HEAD)
docker compose --env-file .env build
docker compose --env-file .env up -d
```

**Two-node peer extension** —
`/Users/flaxscrip/isolation/aegis/deploy/two-node/` (`docker-compose.peer.yml`,
`docker-compose.nodeb.yml`, `harness-credential-exchange.sh`,
`pass-card-didcomm.sh`, `README.md`, `nodeb.env.example`). This is the
directly relevant one — it already implements "two isolated Gatekeepers, no
mediator, connected only by HTTP" (`README.md:1-8`): "no route to the public
internet at all... The peer link is a shared network that is *also*
`internal: true`". It links the pair via
`ARCHON_GATEKEEPER_FALLBACK_URL`/`NODEB_FALLBACK_URL` — an HTTP URL pointed at
the peer's Gatekeeper (`docker-compose.peer.yml:24-30`,
`nodeb.env.example`) — and moves actual content with the admin
export/import CLI or DIDComm, never hyperswarm. `nodeb.env.example` has no
mediator/hyperswarm variable at all, only the fallback URL. This is Aegis's
mediator-less profile; the DMZ design below should sit on top of it, not
reinvent it.

### Does `exportDIDs` return the full chain from genesis, or a range/delta?

**Verdict: GROUNDED — full chain from genesis, no pagination/range parameter exists.**

`exportDID` is defined as exactly the same call `resolveDID` uses to rebuild a
document — there is no separate "recent operations" or "since" query path:

```
/Users/flaxscrip/archon/packages/gatekeeper/src/gatekeeper.ts:981-997
async exportDID(did: string): Promise<GatekeeperEvent[]> {
    return this.db.getEvents(did);
}
async exportDIDs(dids?: string[]): Promise<GatekeeperEvent[][]> {
    if (!dids) dids = await this.getDIDs() as string[];
    const batch = [];
    for (const did of dids) batch.push(await this.exportDID(did));
    return batch;
}
```

`GatekeeperDb.getEvents(did)` (`packages/gatekeeper/src/types.ts:89`) is the
same store `resolveDID` reads at `gatekeeper.ts:698` — one source of truth,
no windowing. Verified live by decoding the finding-4 export payload for the
9-version DID:

```
op 0: type=create  opid=bagaaieravujsiuuzd4o...  previd=(none)
op 1: type=update  opid=bagaaieraxnvknxzgtls...  previd=bagaaieravujsiuuzd4o...
op 2: type=update  opid=bagaaieraa3kk4escbld...  previd=bagaaieraxnvknxzgtls...
op 3: type=update  opid=bagaaierauijgszkmxug...  previd=bagaaieraa3kk4escbld...
op 4: type=update  opid=bagaaieramyexul47c2f...  previd=bagaaierauijgszkmxug...
op 5: type=update  opid=bagaaieratu2j25ysql7...  previd=bagaaieramyexul47c2f...
op 6: type=update  opid=bagaaiera6z2wnxdwyj3...  previd=bagaaieratu2j25ysql7...
op 7: type=update  opid=bagaaieranm5jebm6frr...  previd=bagaaiera6z2wnxdwyj3...
op 8: type=update  opid=bagaaieraopgyxryg7b7...  previd=bagaaieranm5jebm6frr...
```

Nine ops, `previd`-chained end to end, op 0 is the `create` with no `previd`
(genesis), op 8's `opid` matches the `versionId` the plain resolve returned
for `versionSequence: "9"`. This is the complete replayable chain, not a
window — matches "import needs the full chain from genesis" exactly, and
confirms there is nothing to paginate: a DMZ importer that calls `dids/export`
gets everything or nothing, per DID.

### "No gossip mediator ≠ no network"

Confirmed separable. The DMZ still needs **HTTP egress** to reach the
counterparty's `dids/export` (or the peer-fallback `/1.0/identifiers`) — that
dependency is completely independent of whether hyperswarm is running
anywhere. Evidence: the two-node profile's only cross-node wiring is an HTTP
fallback URL (`NODEB_FALLBACK_URL=http://gatekeeper:4224`,
`nodeb.env.example`) and admin export/import over the Gatekeeper's own REST
surface (`README.md`'s `adminA export-did ... | adminB import-did ...`
walkthrough) — no hyperswarm container, no `ARCHON_PROTOCOL` topic, no
mediator env var anywhere in that directory. A DMZ built on this profile needs
outbound HTTP to one counterparty host; it needs nothing resembling a gossip
network to do it.

## Design: DMZ lifecycle (E.3)

**Start: Warden-only, reversible, publishes nothing.** The Warden starts a
DMZ the same way the two-node profile stands up node B — a Gatekeeper process
(local DB, `local` registry, no hyperswarm-mediator container) that the Warden
alone can reach. It fetches one counterparty's `dids/export` over HTTP
(grounded above: this is the only network dependency) and imports the
resulting operation chain. Nothing here needs Sovereign co-sign, because
nothing has left the box and nothing the Sovereign didn't already implicitly
authorize (running the Warden) has happened — this mirrors the existing
deny-by-default posture in `docs/security-model.md` and the release-ladder
invariant in this repo's `CLAUDE.md`, just applied one step earlier, before
disclosure is even on the table. *Assumed, not grounded*: no code in this
repo or in Aegis's harnesses currently automates "start an ephemeral DMZ
Gatekeeper on demand" — that's new plumbing on top of a profile that today is
stood up by hand (`docker compose ... up -d`).

**Promotion splits by destination, and the split is the load-bearing design
choice.**

- **Into a peerless private store** (the Warden's own KB/vault, a partition
  with no members but the Warden) — this stays **local**. No one but the
  Warden's own custody receives the imported material; it's the same trust
  boundary as ingesting any other private document. Warden-authorized is
  sufficient, matching how `docs/credential-delivery/FINDINGS.md` already
  treats a subject-side `importDIDs` as "best-effort," Warden-driven
  plumbing, not a disclosure event.
- **Into a sphere with peers** (a group/registry other members can read) —
  this is **publication**, full stop, and should be treated exactly like any
  other irreversible disclosure this codebase already gates. The grounded
  distinction: importing operations into a Gatekeeper that peers on
  `hyperswarm` (or any shared registry) means those peers' own resolves will
  now see the imported DID's chain — `shareDb()` (`hyperswarm-mediator.ts:355`)
  distributes whatever this node holds, unconditionally, to every connected
  peer. There is no code path that imports "into a shared sphere" but
  suppresses redistribution — the mediator doesn't discriminate by how an
  operation arrived. So "promotion into a peered sphere" **should** want
  Sovereign co-sign, the same step-up this repo already requires for sensitive
  disclosure (`decideRelease()`, `docs/security-model.md`) — because
  functionally it *is* a disclosure: other spheres members receive content
  the Warden alone vetted.

**The DMZ as the natural policy point.** Today's `verify: true` on `resolveDID`
checks exactly two things — the create-operation signature
(`verifyCreateOperation`) and each update's signature plus `previd` chain
integrity (`verifyUpdateOperation`, `gatekeeper.ts:777-819`). That's
**provenance and structural validity** — "this chain is internally consistent
and signed by the key it claims." It is **not** "safety" in any broader
sense: a perfectly well-formed, correctly-signed, chain-valid credential from
an issuer nobody should trust, or a credential shaped like a known schema but
carrying a nonsense claim, passes `verify: true` cleanly. The DMZ is exactly
where a Warden should insert the checks Archon's own verification doesn't
do — issuer recognized (against a trust registry, `docs/reference-archon-
trust-registry` in the user's own notes), claim matches an expected schema,
issuer not on a blocklist, and — because the DMZ already knows which sphere a
credential is being imported *from* — sphere-of-origin as a signal in its own
right. None of this exists in Archon; it's Hearthold-side policy layered on
top of a Gatekeeper that intentionally stays neutral about issuer trust.

## Design: sphere selection safety (E.4)

**Grounded: Keymaster is single-target, per-Gatekeeper-URL, with no runtime
"which node am I talking to" surface for a caller.** `GatekeeperClient` holds
exactly one `baseUrl`, set once at `connect()`
(`packages/gatekeeper/src/gatekeeper-client.ts:59-83`); `Keymaster` holds
exactly one `gatekeeper: GatekeeperInterface` field, assigned once at
construction (`packages/keymaster/src/keymaster.ts:172, 188-190, 202`). There
is no array of gatekeepers, no fallback/failover among endpoints — grepped and
confirmed absent. Hearthold's own `openKeymaster` matches this exactly: one
`config.nodeUrl` → one `GatekeeperClient.create({ url: config.nodeUrl })`
(`packages/core/src/keymaster.ts:23-49`), one `HEARTHOLD_NODE_URL` env var
(`packages/core/src/config.ts:88`). A caller can read `gatekeeper.url`
in-process, but nothing in the CLI or Keymaster's public API prints "here is
the node you are about to publish to" before a call — the CLI's own
`list-registries` only lists registry *names*, not the endpoint identity.

**Nuance the ask gets partly for free: registry already has a per-call
override, for creates.** `createAsset`/`createId` both accept an
`options.registry`, defaulting to `this.defaultRegistry` if omitted
(`keymaster.ts:798-802` for `createAsset`, `keymaster.ts:1611-1636` for
`createId`; instance default set at `keymaster.ts:208`,
`this.defaultRegistry = options.defaultRegistry || 'hyperswarm'`). Updates,
by contrast, have **no** registry choice at call time — `updateDID` reads the
registry straight off the DID's existing `didDocumentRegistration.registry`
(`keymaster.ts:1257`); the only way to change it is the explicit
`changeRegistry(id, registry)` call. So "which sphere" is genuinely two
different questions depending on operation type, and only one of them
(create-time registry) is already parameterized per call.

**What's actually missing, and what to build.** The registry parameter that
exists is *unchecked* — nothing verifies that the caller's intended registry
matches what the connected Gatekeeper's operator actually configured
(`ARCHON_GATEKEEPER_REGISTRIES`), and nothing at all exists for the *node*
dimension (which physical Gatekeeper — which sphere's infrastructure — a
`GatekeeperClient` is pointed at). A misconfigured `HEARTHOLD_NODE_URL`
(pointed at the wrong sphere's node entirely) or a typo'd `registry:` argument
both fail silently or ambiguously today — the former just talks to whatever
is at that URL, the latter either succeeds on an unintended registry the node
happens to support, or throws the same generic "Upstream gatekeeper error"
this repo has already hit for an unrelated reason
(`docs/*` mentions of the hardcoded `ephemeralRegistry` mismatch). Design: every
Hearthold call that **publishes** (as opposed to reads — reads should stay on
ambient config, there's no irreversibility to protect against) should name its
intended sphere explicitly as an argument, and Hearthold — not Archon — should
assert, before the call leaves the process, that the active
`KeymasterHandle`'s `config.nodeUrl` + `config.registry` (or the per-call
registry override) matches the caller's declared target, refusing loudly on
mismatch rather than silently publishing to whatever the ambient config
happens to point at. This is Hearthold-side plumbing; nothing in Archon
enforces or even represents "the sphere I meant to publish to" as a
first-class value to check against.

## Design: DID ↔ swarm-key binding (E.5)

**Grounded: Archon's hyperswarm-mediator accepts every peer that joins its
topic; there is no allow/deny hook wired up today.** `createSwarm()` calls
`swarm.join(topic, { client: true, server: true })` with no firewall/allow
option (`services/mediators/hyperswarm/src/hyperswarm-mediator.ts:236-251`),
and `addConnection()` unconditionally records and starts syncing with any
peer that connects (`hyperswarm-mediator.ts:279-302`) — no allowlist,
blocklist, or DID-check anywhere in that 831-line file, confirmed by grep
across the whole file for `firewall`/`allow`/`blocklist` (zero hits) and
across the whole Archon repo (zero hits, source or docs). The one gate that
does exist is topical, not per-peer: every node on the same
`sha256(ARCHON_PROTOCOL)` topic (`hyperswarm-mediator.ts:758-760`) can join
and sync — a shared-secret-derived topic, not an authenticated per-key
membership check.

**UNVERIFIED — the underlying `hyperswarm` npm library's own capability.**
Archon depends on `hyperswarm@^4.7.14`
(`services/mediators/hyperswarm/package.json:21`), and the upstream library is
documented (from general knowledge, not confirmed against installed source —
no `node_modules/hyperswarm` exists anywhere on this machine to inspect) to
accept a synchronous `firewall(remotePublicKey)` predicate at construction,
used to reject a connection before it's accepted. If that's accurate, Archon
simply isn't using a capability its own dependency already exposes. Flagging
this explicitly as unverified rather than asserting it, per the grounding
rule — the design below should be read as "here is what we'd build on top of
a hook we believe exists but have not inspected the library source to
confirm."

**The design.** Hyperswarm's connection gate — whatever form it takes — keys
on a raw public key with no semantic meaning; Archon's notion of "who belongs
to this sphere" is expressed entirely in `did:cid` documents and group
membership. The binding needed is an explicit, signed statement: *this DID
attests that this swarm public key is its own*, published the same way
Archon already publishes other service/network material into a DID document —
the live DID resolved in this doc already carries an IPFS peer ID and
multiaddrs under `didDocumentData.node.ipfs`
(`{"id":"12D3KooW...","addresses":[...]}`, visible in the finding-2 curl
output above), so there's existing precedent in this exact node for a DID
document carrying network-identity material, just for IPFS/libp2p rather than
a raw hyperswarm key. A DID-signed swarm-key claim would slot into the same
shape. A sync process (not the firewall callback itself) would watch sphere
membership (group/registry changes) and DID-signed key claims, and
materialize an in-memory allowlist — because the firewall hook, if used, is
**synchronous**: it cannot itself resolve a DID, check a group, or make any
I/O call inline without blocking every incoming connection attempt on network
round-trips. That materialization-then-lookup split is the only shape that
works given a synchronous gate. Enforcement of the actual accept/reject
decision is necessarily **Archon-side** (inside the mediator process, at
connection time) — Hearthold can author and maintain the allowlist and the
DID↔key attestations, but it cannot enforce a decision made in a process it
doesn't control; that boundary would need to be a change to (or a
configuration hook exposed by) `hyperswarm-mediator.ts` itself, not something
Hearthold can retrofit from outside.
