# Archon Sandbox Profile — Fully Offline / Egress-Isolated Node

Validates that an Archon node can run identity operations end-to-end with
**zero internet access at runtime** — the target scenario for an air-gapped
hackathon sandbox (NayaOne-style). Runtime image builds/pulls still need
network access (base images, npm packages); only the *running* node is
required to be offline, and that's what's proven below.

## 1. Registry choice: `local`

Archon separates DID **creation** (free, IPFS-anchored) from DID **updates**
(anchored to a pluggable registry — Hyperswarm gossip, Bitcoin, Ethereum,
Solana, Zcash, generic pinning). Every one of those registries other than
one is designed to talk to a network.

Gatekeeper ships a registry literally named `'local'`
(`packages/gatekeeper/src/gatekeeper.ts:533-537`):

```ts
async queueOperation(registry: string, operation: Operation, options...) {
    // Don't distribute local DIDs
    if (registry === 'local') {
        return;
    }
    ...
}
```

Operations for the `local` registry are written to the node's own DB and are
**never queued for any mediator** — there is nothing async left to fail or
time out, no gossip, no chain wallet, no pinning service. This is the
DB-only registry the task calls for. It's also exercised directly in the
upstream test suite (`tests/workflow.js:35`, `keymaster.createSchema(mockSchema,
{ registry: 'local' })`), so it's a supported, not incidental, path.

We deliberately did **not** use `hyperswarm` (the sample.env default) even
though it would also work offline as long as the `hyperswarm-mediator`
container is never started — `local` is the explicit, documented, zero-queue
option and avoids relying on "just don't start that container" as the only
thing standing between this profile and an outbound gossip attempt.

No `BTC:*`, `ETH:*`, `SOL:*`, or `ZEC:*` registries are enabled anywhere in
this profile.

## 2. `.env` (sandbox-relevant settings; full file at repo root, gitignored)

**Bootstrap it with `deploy/setup-node.sh`** — one command produces this exact
hardened `.env` from `sample.env`, generating the values that must be *unique per
install* (admin key, wallet passphrase, and the hyperswarm topic — see §7). Do
not commit a filled-in `.env`; a shared "random" value copied across installs is
no longer random. The script is the canonical "stand up an isolated node" step.

```env
ARCHON_UID=502
ARCHON_GID=20
ARCHON_NODE_ID=sandbox
ARCHON_NODE_NAME=sandbox

# Only the containerized CLI on top of the always-on core services
# (mongodb, redis, ipfs, gatekeeper, keymaster — these are not profile-gated
# at all; leaving COMPOSE_PROFILES empty already gets you a DID-capable
# node). No hyperswarm, no chain mediators, no Lightning/Drawbridge.
COMPOSE_PROFILES=cli

# Generated per install by setup-node.sh — never shared, never committed.
ARCHON_ADMIN_API_KEY=<openssl rand -hex 32>
ARCHON_ENCRYPTED_PASSPHRASE=<openssl rand -hex 16>

ARCHON_GATEKEEPER_REGISTRIES=local
ARCHON_DEFAULT_REGISTRY=local

# Unique private hyperswarm topic (§7): even though hyperswarm is off in this
# profile, setup-node.sh mints a per-install topic so bulk gossip-sync can never
# happen by accident on a shared LAN — only between nodes that set the SAME value.
ARCHON_PROTOCOL=/aegis-private/<openssl rand -hex 32>

# Blanked — this pointed off-box (https://dev.uniresolver.io) and would
# only ever time out under isolation. Defense in depth, not required for
# functionality since nothing in this profile resolves non-did:cid DIDs.
ARCHON_GATEKEEPER_FALLBACK_URL=
ARCHON_GATEKEEPER_CONFIRM_FALLBACK_URL=
```

Everything else is left at `sample.env` defaults (BTC/ETH/SOL/ZEC/Lightning
vars are present in the file but inert — their services never start because
no matching profile is enabled).

## 3. Network isolation

### Setup

`docker-compose.override.yml` (repo root, loaded automatically by `docker
compose` — no extra flags needed):

```yaml
networks:
  default:
    internal: true
```

None of `core.yml` / `gatekeeper-ts.yml` / `keymaster-ts.yml` / `cli.yml`
declare an explicit `networks:` section, so every service in this profile
lands on the implicit Compose "default" network. Overriding that one network
in one file is enough to cut off the whole stack — no per-service edits
required. `internal: true` means Docker does not install a NAT/MASQUERADE
route out of the bridge, so nothing on it can reach the host's upstream
network.

Reproduce with:

```bash
cp sample.env .env            # then edit per section 2 above
mkdir -p data
export GIT_COMMIT=$(git rev-parse --short HEAD)
./deploy/create-internal-network.sh          # once: creates the sealed aegis_internal net
docker compose --env-file .env build
docker compose --env-file .env up -d
```

`docker compose config` confirms the network is applied:

```
networks:
  default:
    name: aegis_internal
    external: true
```

### Isolation hardening (2026-07-31): a unique network name, not `archon_default`

Originally this profile's internal network was named **`archon_default`** — the exact name a stock
Archon deployment (compose project `archon`) creates. Worse, the live network was labelled
`com.docker.compose.project=archon`, so a standard `docker compose up` from any Archon checkout on
this host would have **adopted our sealed network by name**, dropping standard gatekeepers/mediators
straight onto it. `internal: true` blocks *internet* egress but does nothing against a same-host
deployment joining by name.

**Fix:** the network is renamed to **`aegis_internal`** — a unique name no stock deployment resolves to —
with a **pinned `10.83.0.0/24` subnet** (off the Docker-default 172.x range) and `internal: true` intact.
It is created **out-of-band** (`./deploy/create-internal-network.sh` → `docker network create --driver
bridge --internal --subnet 10.83.0.0/24 aegis_internal`) so it carries no stock-compatible compose
labels, and is referenced **`external: true`** by the base override and every aux stack
(ollama/lightning/drawbridge/onion/control/herald) and by Hearthold's agents (via
`HEARTHOLD_DOCKER_NETWORK=aegis_internal`). The name `archon_default` is now free for a stock deployment
to own separately — no shared name, no shared subnet, no adoption. The existing node was migrated live
(connect-to-new → disconnect-from-old, DNS aliases preserved) with no service downtime; verified: all 28
containers on `aegis_internal`, gatekeeper healthy, a real regtest bolt11 settled, `1.1.1.1:443`
unreachable (zero egress).

### Lesson learned: `internal: true` also blocks *published* host ports

On Docker Desktop for macOS (this environment), setting a network to
`internal: true` doesn't just cut outbound egress — it also stops the
compose-published host ports (`4224:4224`, `127.0.0.1:4226:4226`, etc.) from
being reachable from the host at all (`docker port` shows nothing, `curl
localhost:4224` from the host connection-refuses). This is different from
the plain-Linux iptables mental model, where DNAT for published ports is
usually independent of a bridge's outbound NAT rule. We did not chase this
further since it doesn't affect the goal — every CLI operation below runs
through the containerized `cli` service (`./archon` execs into it), which
reaches `gatekeeper`/`keymaster` by service name on the same internal
network, so no host port access was ever needed. Worth knowing up front if
a future profile wants host-reachable APIs *and* an internal network: don't
rely on published ports for that, put a container on a second, non-internal
network instead, or drop `internal: true` and firewall egress a different
way.

### Isolation proof

From inside the `cli` container — direct IP, bypassing DNS entirely:

```
$ docker compose exec cli node -e "http.get({host:'1.1.1.1',port:80,...})"
ERROR (expected): connect ENETUNREACH 1.1.1.1:80 - Local (0.0.0.0:0)
```

DNS resolution also fails (no resolver path exists on an internal network):

```
$ docker compose exec cli node -e "dns.lookup('google.com', ...)"
DNS ERROR (expected): getaddrinfo EAI_AGAIN google.com
```

Same result from `gatekeeper` (the service most likely to have an
outbound path baked in, via `ARCHON_GATEKEEPER_FALLBACK_URL`, which we also
blanked):

```
$ docker compose exec gatekeeper node -e "http.get({host:'8.8.8.8',port:443,...})"
ERROR (expected): connect ENETUNREACH 8.8.8.8:443 - Local (0.0.0.0:0)
```

And from `ipfs` — zero swarm peers (no bootstrap peer was reachable), and a
direct `wget` fails the same way:

```
$ docker compose exec ipfs ipfs swarm peers
(empty)
$ docker compose exec ipfs wget -T 5 -qO- http://1.1.1.1
wget: can't connect to remote host (1.1.1.1): Network is unreachable
```

Re-checked after the `cli` image was rebuilt mid-session (section 5) — same
`ENETUNREACH` result, confirming isolation survived the rebuild/recreate.

At no point was the isolation relaxed to make any test pass.

## 4. Acceptance suite — all steps offline, on `ARCHON_GATEKEEPER_REGISTRIES=local`

Run via `./archon <command>`, which execs into the isolated `cli` container
(`docker compose exec -it cli node scripts/archon-cli.js ...`).

| # | Step | Result |
|---|------|--------|
| 1a | `create-wallet` | **PASS** — wallet created, node ID `sandbox` auto-provisioned |
| 1a | `create-id warden-test` | **PASS** — `did:cid:bagaaieraywlt6...pnita` |
| 1a | `create-id emissary-test` | **PASS** — `did:cid:bagaaiera5ybao...l6yfa` |
| 1b | `resolve-did` (both) | **PASS** — `confirmed: true`, `registry: "local"` on both, immediately (no anchoring wait — expected, since `local` never queues) |
| 1b | `resolve-did-version <warden> 1` | **PASS** — returns v1 document |
| 1c | `encrypt-message` (warden → emissary) | **PASS** — produced `did:cid:bagaaierau66sw...74trgq` |
| 1c | `decrypt-did` (emissary reads it) | **PASS** — plaintext recovered exactly |
| 1d | `create-schema share/schema/email.json` | **PASS** — `did:cid:bagaaierawg4cl...vxs7a` |
| 1d | `bind-credential <schema> <emissary>` | **PASS** — unsigned bound credential JSON |
| 1d | `issue-credential` | **PASS** — `did:cid:bagaaierao64oh...k6fftq` |
| 1d | `accept-credential` (emissary) | **PASS** |
| 1d | verify the credential (`view-credential`) | **FAIL → fixed → PASS** (see §5) |
| 1e | `create-vault` | **PASS** — `did:cid:bagaaierafyiep...q57ra` |
| 1e | `add-vault-item` | **PASS** |
| 1e | `get-vault-item` | **PASS** — byte-identical `diff` against the original file |

`list-registries` (run once, for the record): `local` — nothing else is
reachable to this node, by construction.

## 5. Failure diagnosed and fixed: `view-credential` / `verify-file`

**Symptom:** `./archon view-credential <did>` decrypted and printed the
credential correctly, then crashed:

```
TypeError: keymaster.verifyProof is not a function
    at Command.<anonymous> (file:///app/scripts/archon-cli.js:642:45)
```

**Diagnosis — this is not a network/isolation failure.** It reproduces
identically online. Root cause: `scripts/archon-cli.js` calls
`keymaster.verifyProof(credential)` assuming the full `Keymaster` interface.
When the CLI is wired to the containerized `keymaster` *service* (the
documented deployment shape — `./archon` always execs into `cli`, which
talks to `keymaster` over HTTP via `KeymasterClient`), `verifyProof` was
simply never implemented on `KeymasterClient`
(`packages/clients/src/keymaster-client.ts`) — confirmed by `grep -c
verifyProof` returning `0` in that file, versus a real implementation in
the core library at `packages/keymaster/src/keymaster.ts:1235`. The gap
slipped past the type checker because `KeymasterInterface`
(`packages/clients/src/keymaster-types.ts`) never declared the method
either, so `KeymasterClient implements KeymasterInterface` compiled clean
despite missing it. Same root cause would also break `verify-file`
(`scripts/archon-cli.js:463`), which calls the identical missing method.

The server side was already complete and unused: `services/keymaster/server/src/keymaster-key-router.ts:377`
exposes `POST /api/v1/keys/verify` (`{ json } → { ok }`), backed by the real
`verifyProof`. Only the client-side wrapper was missing.

**Fix applied** (in this working tree, not a workaround of isolation — this
bug fires identically online):

- `packages/clients/src/keymaster-types.ts`: added
  `verifyProof<T extends PossiblyProofed>(obj: T): Promise<boolean>;` to
  `KeymasterInterface`.
- `packages/clients/src/keymaster-client.ts`: implemented it as a thin POST
  to `/keys/verify`, matching the existing `encryptJSON`/`decryptJSON`
  pattern in the same file.

Rebuilt just the `cli` image (`docker compose build cli`), recreated the
container, re-ran `view-credential` — wallet/ID state persisted across the
rebuild (it lives in `./data`, a bind mount) and the command now completes:

```
Claims:     { "email": "TBD" }
Proof:      valid
```

This is a small, additive, type-checked change worth upstreaming — it's a
real client/server parity gap, not specific to the sandbox profile.

## 6. Lesson learned: `ephemeralRegistry` is hardcoded to `hyperswarm` — but the fix needs no mediator, no network, and no "private channel"

While probing the credential-verify failure we also tried the
challenge/response flow (`create-challenge` → `create-response` →
`verify-response`) as an alternate verification path. It failed:

```
Error: Invalid operation: non-local registry=hyperswarm
```

**First (wrong) diagnosis, corrected below.** We initially assumed this was
Gatekeeper rejecting `hyperswarm` as an unsupported registry name, and
guessed that adding it to `ARCHON_GATEKEEPER_REGISTRIES` would fix it. It
didn't — same error, verified live (`ARCHON_GATEKEEPER_REGISTRIES=local,hyperswarm`,
gatekeeper restarted, no mediator container, still fully isolated). That
edit was a no-op anyway: `packages/gatekeeper/src/gatekeeper.ts:94` already
defaults `supportedRegistries` to `['local', 'hyperswarm']` whenever
`ARCHON_GATEKEEPER_REGISTRIES` doesn't override it, and our explicit
`local`-only value was already narrower than the default — the message
text just happened to look like a "registry not supported" error.

**Actual root cause:** a controller/asset registry-consistency invariant at
`packages/gatekeeper/src/gatekeeper.ts:462`:

```ts
if (doc.didDocumentRegistration && doc.didDocumentRegistration.registry === 'local'
        && operation.registration.registry !== 'local') {
    throw new InvalidOperationError(`non-local registry=${operation.registration.registry}`);
}
```

An identity whose *own* agent DID is anchored to `local` is barred from
authoring *any* asset on a different registry — one-directional (a
`hyperswarm`-anchored identity may still author `local` assets fine).
Separately, `packages/keymaster/src/keymaster.ts:230` hardcodes
`this.ephemeralRegistry = 'hyperswarm'` with no env override, used for
every short-lived asset type — challenges/responses (`:3649`),
credential-request notices (`:3433`), poll/ballot distribution (`:4507`,
`:4532`), and dmail sending (`:5187`). Put together: any identity created
under our default `ARCHON_DEFAULT_REGISTRY=local` can never touch those
five features, regardless of what `ARCHON_GATEKEEPER_REGISTRIES` allows.

**The actual, verified-live fix needs no mediator, no network, no custom
protocol/topic:** create the identities that need those features on the
`hyperswarm` registry instead of `local` (`create-id <name> -r hyperswarm`).
Gatekeeper's create-event path treats registry purely as a label when
nothing consumes the distribution queue — `didDocumentMetadata.confirmed`
is unconditionally `true` for create events regardless of registry
(`gatekeeper.ts:726`), and queuing a hyperswarm-registry operation
(`gatekeeper.ts:540`, "Always distribute on hyperswarm") is a plain local
DB write, not a network call. So a `hyperswarm`-registered identity
resolves immediately and confirmed, offline, exactly like `local` — it just
also satisfies the consistency check above. Verified end-to-end on this
same isolated node, no mediator running:

```
$ ./archon create-id warden-hs -r hyperswarm      # confirmed: true, offline
$ ./archon create-id emissary-hs -r hyperswarm    # confirmed: true, offline
$ ./archon use-id warden-hs && ./archon create-challenge
challenge: did:cid:bagaaieraabelgjm...dvkeciq
$ ./archon use-id emissary-hs && ./archon create-response <challenge>
response: did:cid:bagaaieramdpkn3iu...piphcukq
$ ./archon use-id warden-hs && ./archon verify-response <response>
{ ..., "match": true, "responder": "did:cid:bagaaieras5a2qi...dk6l5wf5a" }
```

**Why running an actual hyperswarm-mediator process — even air-gapped, even
on a private/custom `ARCHON_PROTOCOL` topic instead of the public
`/ARCHON/v0.8-beta` channel — would not have helped, and isn't needed:**

1. It doesn't touch the failing check. The block was never "no mediator is
   consuming the queue" — it's the synchronous controller-registry
   comparison above, which runs at operation-verification time regardless
   of whether any mediator exists.
2. Hyperswarm's topic string scopes *who you rendezvous with once connected
   to the DHT* — it doesn't gate *whether the node attempts to reach the
   DHT at all*. A "private channel" doesn't create isolation; `internal:
   true` already does that (§3), and it would make any bootstrap attempt
   fail the same `ENETUNREACH` way we already proved for IPFS's swarm
   bootstrap. Net effect of running it: one more container perpetually
   retrying a connection it can never make — inert, not harmful, but no
   closer to unblocking anything.
3. Even a fully working mediator wouldn't matter for a single-node test
   like this one: `warden-hs` and `emissary-hs` share one wallet on one
   node, so `create-response`/`verify-response` never need to move data
   over a network — hyperswarm's actual job (moving operations *between*
   nodes) is out of scope for validating the sandbox on one machine.

**Caveat if adopted:** the "always distribute on hyperswarm"
queue write at `gatekeeper.ts:540` runs unconditionally for any non-`local`
registry and has no `maxQueueSize` cap (unlike the pin queue and
per-registry queues just below it, `gatekeeper.ts:544-561`). With no
mediator ever draining it, that queue grows without bound for the lifetime
of the node. Not a problem for a demo/hackathon window; worth knowing
before running this pattern for a long-lived sandbox.

**This profile's default stays `local`-only** (§2) — the required
acceptance suite in §4 passed in full on it, and it's the strictly minimal,
zero-registry-queue-growth option. `-r hyperswarm` per-identity is
documented here as an opt-in for anyone who specifically needs
challenges/polls/dmail; it was not made the default. (Test identities
`warden-hs` / `emissary-hs` created for this experiment remain in the
wallet; harmless, not otherwise referenced.)

## 7. Hardened default: a unique per-install hyperswarm topic (`ARCHON_PROTOCOL`)

Even with hyperswarm off in this profile, the *value* of `ARCHON_PROTOCOL`
matters the moment a node is carried onto a shared network — so we harden it as
a first-class install default.

**The footgun.** If hyperswarm is ever enabled, Archon replicates the node's
**entire DID database** to any peer it discovers on its **topic**. The topic is
`sha256(ARCHON_PROTOCOL)` (`hyperswarm-mediator.ts:758`), and the upstream
default — `/ARCHON/v0.8-beta` — is **shared by every Archon node in existence**.
On a shared LAN, mDNS/local discovery doesn't even need the public DHT: two nodes
sitting on that default topic would silently bulk-replicate to each other. The
scenario we care about is exactly the friendly one — a laptop full of private
history joining a friend's home network — where "isolated" must not quietly mean
"syncing everything to whoever else runs Archon here."

**Why not just ship a random default.** A hardcoded "random" topic committed to
the repo is *not random*: every install that copied it would share it, recreating
the same shared-topic footgun with a different constant. The only correct default
is one **generated per install**.

**The fix.** `deploy/setup-node.sh` mints `ARCHON_PROTOCOL=/aegis-private/$(openssl
rand -hex 32)` when it creates the `.env` (same treatment as the admin key and
wallet passphrase — no shared secrets across installs). Result: hyperswarm
bulk-sync becomes **opt-in by construction** — it can only occur between nodes
whose operators *deliberately* set the **same** topic (a private swarm between
trusted friends), never by accident. Two Aegis nodes never share a topic unless
someone chooses it.

This is defense-in-depth for the `local`-only profile (hyperswarm isn't running),
but it's precisely the default you want hardened *before*, not after, the first
time a node leaves its own machine. Cross-node work in this repo uses the safe
peering model instead — **on-demand fallback resolution**, one DID at a time
(`deploy/two-node/README.md`), never bulk gossip.

## 8. Stretch goal: local regtest Lightning network, fully offline

Standalone compose file — `docker-compose.lightning-regtest.yml` — layered
onto the *same* `archon_default` internal network as an opt-in add-on, not
part of the required node profile. It runs the images Polar itself uses
under the hood (`polarlightning/bitcoind:28.0`, `polarlightning/lnd:0.18.5-beta`),
hand-assembled into a compose file rather than driven through Polar's
Electron GUI, which isn't usable in this headless environment.

`regtest` is a private, locally-mined chain by construction — there is no
real seed, no real peer, no real fee market, so there was never any
built-in dependency on the internet here; the isolation guarantee comes
entirely from the underlying `archon_default` network already being
`internal: true` (§3), same as every other container in this sandbox.
`bitcoind` is additionally started with `-dnsseed=0 -upnp=0 -listenonion=0
-discover=0 -dns=0` as defense in depth, and both `lnd` nodes run with peer
bootstrapping disabled by default (`SRVR: Auto peer bootstrapping is
disabled`, confirmed in the startup logs) — so nothing here would attempt
egress even without the network-level block.

### Bring-up

```bash
docker compose -f docker-compose.lightning-regtest.yml up -d
```

Driven the same way as the archon CLI — `docker compose -f
docker-compose.lightning-regtest.yml exec <service> ...` — no host ports
are published (matches the §3 lesson: published ports don't work on an
`internal: true` network on Docker Desktop anyway, so this was never a
viable path here regardless).

### Transcript

```
$ bitcoin-cli -regtest createwallet miner
$ bitcoin-cli -regtest -rpcwallet=miner generatetoaddress 101 <miner-addr>
$ bitcoin-cli -regtest -rpcwallet=miner getbalance
50.00000000

$ lncli getinfo   # both alice and bob — --noseedbackup auto-creates and
                   # unlocks an unencrypted wallet on first run on this
                   # image; no interactive `lncli create` needed
synced_to_chain: true   (both)

$ bitcoin-cli sendtoaddress <alice-addr> 5   # + 6 confirmations
$ lncli walletbalance   # alice
confirmed_balance: 500000000   (5 BTC, sats)

$ bitcoin-cli sendtoaddress <bob-addr> 1   # + 6 confirmations
$ lncli walletbalance   # bob
confirmed_balance: 100000000   (1 BTC, sats)

$ lncli connect <bob-pubkey>@bob:9735       # container hostname, internal
                                              # network only — never a host
                                              # or public address
$ lncli listpeers   # alice
address: 172.18.0.9:9735   (bridge-internal IP)

$ lncli openchannel --node_key=<bob-pubkey> --local_amt=1000000 --push_amt=200000
funding_txid: 2371cd78...d21d6b58
$ bitcoin-cli generatetoaddress 6 <miner-addr>
$ lncli listchannels   # both sides
active: true, capacity: 1000000, local/remote balance 796530/200000 (alice) — 200000/796530 (bob)

$ lncli addinvoice --amt=50000 --memo="sandbox stretch goal: offline LN payment"   # bob
payment_request: lnbcrt500u1p49uhq...

$ lncli payinvoice --force <payment_request>   # alice
Payment status: SUCCEEDED, preimage: 9a204b8a...

$ lncli listinvoices   # bob
state: SETTLED | amt_paid_sat: 50000

$ lncli listchannels   # both sides, after payment
alice: local_balance 746530, remote_balance 250000
bob:   local_balance 250000, remote_balance 746530
```

**PASS** — one invoice created by `bob`, paid by `alice`, settled and
reflected in both sides' channel balances (Δ = exactly 50,000 sats), never
touching anything outside `archon_default`.

### Isolation proof (same pattern as §3, repeated for the new containers)

```
$ docker compose -f docker-compose.lightning-regtest.yml exec bitcoind curl -m 5 http://1.1.1.1
curl: (7) Failed to connect to 1.1.1.1 port 80 after 0 ms: Couldn't connect to server
$ bitcoin-cli getconnectioncount
0   # zero P2P peers — single-node regtest, no real network ever reached
$ docker compose -f docker-compose.lightning-regtest.yml exec lnd-alice curl -m 5 http://8.8.8.8
curl: (7) Failed to connect to 8.8.8.8 port 80 after 0 ms: Couldn't connect to server
```

### One wiring bug hit and fixed along the way

`polarlightning/lnd:0.18.5-beta` rejected `--nat=false` at startup
(`bool flag \`--nat' cannot have an argument`) — this build's flag parser
doesn't accept `=false` on a boolean flag; since `--nat` already defaults
to off, the fix was simply to omit the flag rather than pass it explicitly.
Not an isolation issue, just a flag-syntax mismatch against this specific
image/version.

### Teardown

```bash
docker compose -f docker-compose.lightning-regtest.yml down
```

(Deliberately not `--remove-orphans`: this file shares the compose project
name — both files default to the directory name `archon` — with the main
`docker-compose.yml`, so `down` without that flag only removes the three
services this file defines, leaving the core node running. Worth knowing:
running `docker compose -f docker-compose.lightning-regtest.yml ps` also
lists the *core* node's containers for the same reason, since Compose scopes
by project name, not by which file listed which service.)

## 9. Stretch goal, extended: Archon's own Lightning zap (CLN + LNbits + Drawbridge), fully offline

§8 proved raw Lightning plumbing works offline with vanilla LND. This section
goes further: **Archon's own wallet subsystem** — Keymaster → Drawbridge →
lightning-mediator → LNbits → CLN — sending a zap between two DIDs
(`warden-test`, `emissary-test`), using the CLI/API surface Keymaster
actually exposes, not a bypass. This is the deliberately-chosen path per the
project's design: Keymaster is meant to stay the single wallet subsystem
across the system (Lightning invoicing, dmail, group vaults, etc. are all
future user-facing features built on the same Keymaster core), so this
validates that subsystem specifically rather than proving Lightning works
in the abstract.

### Bring-up

New compose file, `docker-compose.lightning-zap.yml`, layered on top of the
core stack + `docker-compose.lightning-regtest.yml` (reuses that stack's
`bitcoind` as CLN's regtest backend — one shared regtest chain, two
Lightning implementations on it, exactly like Polar does):

```bash
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.lightning-zap.yml \
  up -d cln-mainnet-node drawbridge-init lnbits-init lnbits lightning-mediator drawbridge
```

Explicitly bypasses the `lightning`/`drawbridge` `COMPOSE_PROFILES` gate and
skips `tor`, `herald`, `herald-client`, `rtl`, `rtl-init`, `drawbridge-client`
— none of which this flow depends on (confirmed by tracing `depends_on`
chains: only `gatekeeper`, `redis`, and the explicitly-listed services are
pulled in).

Two `.env` additions carry this (see inline comments in `.env` itself):

- `ARCHON_KEYMASTER_GATEKEEPER_URL=http://drawbridge:4222` — Keymaster only
  sees Lightning/DIDComm capability when pointed at Drawbridge instead of
  plain Gatekeeper (`requireDrawbridge()` in `packages/keymaster/src/keymaster.ts:3047`
  casts its Gatekeeper client and checks for Lightning-specific methods).
  Drawbridge transparently proxies every plain Gatekeeper route, so this
  does not regress any already-validated §4 step — confirmed live
  (`list-ids`, `list-registries` re-checked after recreating `keymaster`).
- `ARCHON_DRAWBRIDGE_PUBLIC_HOST=https://sandbox.archon.local` — see "the
  offline zap trick" below.

### Three vendor-image/script bugs found and fixed

All three are genuine defects independent of this sandbox — each would
reproduce identically on a real mainnet deployment of this exact image
version. None were fixed by relaxing isolation.

**1. `ghcr.io/lightning-goats/cl-hive-node` (both `3.1.0` and `3.4.0`)
generates a lightningd config with `grpc-port=` and `clnrest-port=`/
`clnrest-protocol=`/`clnrest-host=`, but the bundled lightningd (`v25.12.1`)
has neither plugin at all** (confirmed via `lightningd --help` — no such
options exist; the binaries aren't in `/usr/local/libexec/c-lightning/plugins`).
lightningd rejected each as unknown and crash-looped to `FATAL`. The image
separately bundles a third-party REST gateway (`/opt/c-lightning-REST`) but
never runs it via supervisord, so port 3001 has nothing listening on it
regardless of the config fix. Fix: `scripts/sandbox/cln-lightningd-wrapper.sh`,
bind-mounted over the vendor's `/usr/local/bin/lightningd-wrapper.sh`, strips
those config lines on every start (the config is regenerated fresh on every
container start, so a one-off edit would be clobbered).

**2. `drawbridge-init`/`rtl-init`/`lnbits-init`'s inline scripts hardcode
`RPC_SOCKET=/data/lightning/bitcoin/bitcoin/lightning-rpc`** — the
`NETWORK=bitcoin`/mainnet on-disk path — regardless of the actual configured
`NETWORK`, so they timed out waiting on a path that doesn't exist under
`NETWORK=regtest` even with lightningd fully healthy. Their real output (CLN
REST runes) is only consumed by Drawbridge's L402 paywall feature
(confirmed by tracing `ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL`/`_CLN_RUNE`
usage in `services/mediators/lightning/src/lightning-mediator.ts` to the
`/l402/invoice` and `/l402/check` routes only — L402 is
`ARCHON_DRAWBRIDGE_L402_ENABLED=false` by default and untouched by the
wallet/zap flow), so `drawbridge-init`/`lnbits-init` are overridden to a
no-op `echo` rather than patched — there is no rune consumer downstream of
them in this flow.

**3. LNbits' own `scripts/lnbits-entrypoint.sh` gates its "wait for CLN REST,
require a rune" branch on whether `CLNREST_URL` is set at all**, independent
of `LNBITS_BACKEND_WALLET_CLASS` — so switching backends still hit "rune
required". Fix: `CLNREST_URL=` (empty) in the `lnbits` service override.

### Sidestepping the missing CLN REST plugin: raw RPC socket instead

Since this image's lightningd has no REST/gRPC plugin, LNbits can't use its
default `CLNRestWallet` backend at all. LNbits ships an older backend,
`CoreLightningWallet` (`/app/lnbits/wallets/corelightning.py`), that talks to
CLN directly over the raw JSON-RPC unix socket instead — no REST, no gRPC,
no rune:

```yaml
lnbits:
  environment:
    - LNBITS_BACKEND_WALLET_CLASS=CoreLightningWallet
    - CORELIGHTNING_RPC=/data/lightning/regtest/regtest/lightning-rpc
```

The socket path is on the same data volume already shared read-only between
CLN and LNbits (`../../data/cln-mainnet:/data/lightning`) — no new volume
needed. Confirmed working: `Backend CoreLightningWallet connected and with a
balance of 0 msat` in LNbits' own startup log.

**Also found: LNbits' image bakes a fully-resolved `.venv`/`uv.lock` into
`/app` at build time, but `uv run lnbits ...` still performs its default
project-sync check on every container start, which tries to fetch
`hatchling` from PyPI** and fails under isolation
(`Temporary failure in name resolution`). Fix: `UV_OFFLINE=1` in the
`lnbits` environment — forces `uv` to use only the already-baked venv,
matching "runtime must not need network" without needing internet on every
restart. (LNbits also makes harmless, non-blocking attempts to fetch a BTC
price feed and an extensions manifest from public services at startup —
same established pattern as IPFS/bitcoind bootstrap attempts elsewhere in
this document: fails cleanly, doesn't block anything.)

**Also found: port 5000 (LNbits' default) is claimed by macOS's AirPlay
Receiver on this host** (`ControlCenter`, confirmed via `lsof`) — unrelated
to Archon, just remapped host-side to `15000:5000` (`ports: !override`, the
compose-spec tag that actually replaces an inherited list — a plain
key-for-key override left the base `5000:5000` mapping in place
alongside the new one, still colliding).

### The offline zap trick, precisely

`lightning-mediator.ts:509-519` (already in the codebase, not something
added for this sandbox): when a DID-based zap's recipient `#lightning`
service endpoint hostname matches this node's own `getPublicHost()`, the
mediator swaps the outbound invoice-fetch to `http://drawbridge:<port>`
internally and skips Tor entirely. `getPublicHost()`
(`lightning-mediator.ts:104-117`) checks `ARCHON_DRAWBRIDGE_PUBLIC_HOST`
*before* ever reading the Tor onion hostname file. Setting that variable to
a fake-but-syntactically-valid `https://sandbox.archon.local`:

- satisfies the SSRF checks on the published endpoint (`https:` protocol,
  hostname doesn't match the private-IP regex `^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)`),
- matches `publishLightning`'s own endpoint construction
  (`packages/keymaster/src/keymaster.ts:3247`: `publicHost = result.publicHost || drawbridge.url`,
  where `result.publicHost` is this same `getPublicHost()` value returned
  from the `/lightning/publish` call),
- and is **never actually dialed** — once the hostnames match, the mediator
  substitutes the internal `drawbridge` URL before the `fetch()` call ever
  happens.

Confirmed on the resolved DID document:
```json
{"id": "...#lightning", "type": "Lightning",
 "serviceEndpoint": "https://sandbox.archon.local/invoice/bagaaiera..."}
```

No Tor container was ever started for this flow. This is not a weakened
security check — the SSRF protections ran exactly as designed; the
loop-back is an existing, intentional escape hatch for exactly this
same-stack case.

### Transcript

All calls go through Keymaster's REST API directly (`POST /api/v1/lightning/*`
against `keymaster:4226` from inside the `cli` container, with
`X-Archon-Admin-Key`) — the CLI script (`scripts/archon-cli.js`) has no
Lightning subcommands at all; those exist only as MCP server tools, which in
this environment are wired to a different (non-sandbox) Archon node, so they
were not used here.

```
$ curl -X PUT lnbits:5000/api/v1/auth/first_install \
    -d '{"username":"sandboxadmin","password":"sandboxpass123","password_repeat":"sandboxpass123"}'
# LNbits gates ALL routes behind first-run setup (settings.first_install) —
# unrelated to CLN/regtest, just a fresh-instance step, one-time.

$ use-id warden-test
$ POST /api/v1/lightning {}                     # addLightning
{"walletId":"16c582d6...","adminKey":"34143f8b...","invoiceKey":"e98b9887..."}
$ POST /api/v1/lightning/publish {}              # publishLightning
{"ok":true}

$ use-id emissary-test
$ POST /api/v1/lightning {}
{"walletId":"9112cc17...","adminKey":"706793d1...","invoiceKey":"fda4cd82..."}
$ POST /api/v1/lightning/publish {}
{"ok":true}

# Fund warden-test from lnd-alice (§8's regtest LND), a real Lightning
# payment across a real regtest channel — nothing Archon-specific yet:
$ lncli connect <cln-pubkey>@cln:9736
$ lncli openchannel --node_key=<cln-pubkey> --local_amt=2000000     # alice -> cln
$ bitcoin-cli generatetoaddress 9 <miner-addr>
$ lncli listchannels   # both alice<->bob and alice<->cln: active: true

$ use-id warden-test
$ POST /api/v1/lightning/invoice {"amount":100000,"memo":"funding from lnd-alice"}
{"paymentRequest":"lnbcrt1m1p49u6nw...","paymentHash":"1cd63b19..."}
$ lncli payinvoice --force <paymentRequest>      # lnd-alice, real regtest LN payment
Payment status: SUCCEEDED, preimage: 1cd09adb...
$ POST /api/v1/lightning/balance {}
{"balance":100000}

# The actual demonstration: Archon zap, DID to DID
$ POST /api/v1/lightning/zap {"did":"<emissary-test DID>","amount":25000,"memo":"archon zap: fully offline, CLN + LNbits"}
{"paymentHash":"9f566f2bb736adf2cdac4f491d5c01010a7d45547567a4fd63671f41e162ca40"}

$ POST /api/v1/lightning/balance {}   # warden-test
{"balance":75000}
$ use-id emissary-test
$ POST /api/v1/lightning/balance {}   # emissary-test
{"balance":25000}
```

**PASS** — 100,000 → 75,000 / 0 → 25,000, exact 25,000-sat transfer, through
Keymaster's real Lightning wallet subsystem, DID to DID, zero network egress
at any point.

### Isolation proof (same pattern as §3/§8, repeated for the new containers)

```
$ docker exec aegis-cln-mainnet-node-1 curl -m5 http://1.1.1.1
curl: (7) Failed to connect to 1.1.1.1 port 80 after 0 ms: Couldn't connect to server
$ docker exec aegis-lnbits-1 curl -m5 http://1.1.1.1
curl: (7) Failed to connect to 1.1.1.1 port 80 after 0 ms: Couldn't connect to server
$ docker exec aegis-lightning-mediator-1 node -e "http.get({host:'1.1.1.1',...})"
ERROR (expected): connect ENETUNREACH 1.1.1.1:80 - Local (0.0.0.0:0)
$ docker exec aegis-drawbridge-1 node -e "http.get({host:'1.1.1.1',...})"
ERROR (expected): connect ENETUNREACH 1.1.1.1:80 - Local (0.0.0.0:0)
```

### Teardown

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.lightning-zap.yml \
  down cln-mainnet-node drawbridge-init lnbits-init lnbits lightning-mediator drawbridge
```

## 11. DIDComm relay (for Hearthold) + containerized Ollama

Two further additions, both consumed by a separate downstream project
(`~/hearthold` — a multi-agent app built on this node, out of scope for this
document beyond the node-side changes it needed) rather than by anything in
this repo's own acceptance suite.

### DIDComm relay, `ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS`

Brought up the same way as every other add-on this session — explicitly
naming the service to bypass the `didcomm` `COMPOSE_PROFILES` gate:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.lightning-zap.yml \
  up -d didcomm
```

`ARCHON_DIDCOMM_URL=http://didcomm:4236` (`.env`) and recreating `drawbridge`
to pick it up gets `/api/v1/capabilities` → `didcomm: true` and
`/didcomm/health` → `{"ready":true}`.

**Why this needed a real (if narrowly-scoped) SSRF-guard opt-in, unlike
Lightning's zap loopback (§9):** DIDComm delivery resolves the *recipient's*
published endpoint and **genuinely dials it**
(`services/didcomm/server/src/didcomm-api.ts`, `POST /deliver` →
`POST <endpoint>/api/v1/messages`) — there is no same-host string-compare
shortcut here the way `lightning-mediator.ts:509-519` has. Our node
advertises the symbolic `https://sandbox.archon.local/didcomm` (via
`ARCHON_DRAWBRIDGE_PUBLIC_HOST`, §9) — fine for Lightning's string
comparison, but DIDComm actually tries to connect to it and gets nothing (a
non-resolving host, by design). Pointing an agent at the real in-network
`http://drawbridge:4222/didcomm` instead then hits a second, independent
guard: `/deliver` SSRF-blocks clearnet delivery to anything that isn't
`https:` + non-private (`didcomm-api.ts:151-158`), rejecting `http://` and
private hosts alike with `400 private/loopback endpoint not allowed`.

Fix — `docker-compose.override.yml`:
```yaml
services:
  didcomm:
    environment:
      - ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS=true
```

This lifts only the **application-level** check (confirmed by reading the
guard directly, not just trusting the description that arrived with it):
the code path still does a real `fetch()`, and the network underneath is
still `internal: true` — a dial to any public IP still hard-fails
`ENETUNREACH` regardless of this flag. It's the same flag Hearthold's own
`docs/manual-testing.md` documents for dev/test use, not something invented
for this sandbox.

**A cleaner option, not implemented this pass:** give the DIDComm relay the
same self-loopback the Lightning mediator already has — when a recipient's
endpoint host matches this node's own `getPublicHost()`, write to the local
mailbox directly instead of dialing out. That would let DIDComm reuse the
existing `sandbox.archon.local` convention with no private-egress flag and
no per-consumer endpoint override. Left as a documented upstream
enhancement rather than done here, since the opt-in flag already satisfies
the isolation requirement without it.

### Ollama, containerized

A separate stretch need: Hearthold's on-device artefact classifier calls an
Ollama endpoint. The host already had Ollama running natively with models
pulled (`qwen3:8b`, the classifier's default) — but `host.docker.internal`
does not resolve on this `internal: true` network (confirmed empirically,
same `EAI_AGAIN` pattern as every other blocked-egress attempt in this
document), so a container here cannot reach anything on the host at all.
Rather than open a host-reachability hole, `docker-compose.ollama.yml` runs
Ollama as its own container on `archon_default`:

```bash
docker compose -f docker-compose.ollama.yml up -d
```

Reuses the host's already-pulled model weights instead of re-downloading —
`~/.ollama/models` (not the whole `~/.ollama`, which also holds the host's
Ollama registry signing key, logs, and shell history) is bind-mounted
**read-only** into the container. Read-only is deliberate, not incidental:
this container should only ever *serve* an existing model, never `ollama
pull` a new one (that would need real internet, defeating the point), so
making the mount structurally read-only enforces that rather than relying
on nobody happening to run the wrong command.

Confirmed: `ollama list` inside the container shows all of the host's
models with no download; `bash -c 'exec 3<>/dev/tcp/1.1.1.1/80'`
inside the container fails `Network is unreachable` — same isolation
guarantee as everything else, no exception carved out for this container.

**Model choice matters more than size here — pick a non-thinking model.**
Docker Desktop on macOS has no Metal/GPU passthrough, so this container runs
CPU-only. Hearthold's default classifier model `qwen3:8b` took >60s/call
that way; the obvious "go smaller" reflex (`qwen3.5:2b`) made it *worse* —
never finished a trivial prompt in 180s — because qwen3/qwen3.5 are hybrid
*reasoning* models that emit `<think>` tokens, and the reasoning tax, not
the parameter count, dominated the latency. Switching to `qwen2.5:3b` (the
non-thinking instruct sibling) dropped the same classify to ~6s raw / ~11–15s
through Hearthold's fuller prompt, with correct results. The model is
selected entirely on the Hearthold side (`HEARTHOLD_CLASSIFIER_MODEL`, which
also drives its RAG answerer) — no node-side change; Ollama just serves
whatever tag is asked for from the read-only mount. Lesson for anyone tuning
this: on a CPU-only container, prefer a small *instruct* model over any
reasoning model regardless of size.

## 12. Going fully offline — the portable bundle

Everything above proves the stack is isolated *at runtime*, but the images
are still **built and pulled with internet** (npm, base images, `docker
pull`, `ollama pull`). For a genuinely air-gapped target — a box with no
internet *ever*, not just at runtime — that build/pull phase has to be
eliminated too. `deploy/offline/` does that: a two-machine, pack-then-load
flow that ships every runtime artifact so the complete Aegis + Hearthold
demo boots with the cord cut.

- **`pack-offline-bundle.sh`** (on the online prep machine — the one where the
  demo already runs): `docker save`s the exact image set in
  `images.list` (15 images: the 6 `archetech/*` Node services, the 4
  third-party infra images, the 4 Lightning images, and `hearthold:sandbox`)
  into one gzipped tarball — shared Node base layers dedupe, so 16 GB of raw
  images collapse to **5.3 GB**. It then packages *only* the two Ollama
  models the classifier needs (`qwen2.5:3b` + `nomic-embed-text` — their 9
  content-addressed blobs + manifests, **2.0 GB**, not the host's whole
  `~/.ollama`), plus the compose overlays and Hearthold's compose/scripts.
  It never touches the network — if an image or model is missing it stops and
  says "build/pull it first."
- **`load-offline-bundle.sh`** (on the air-gapped target): `docker load`s the
  images (restoring their original tags, so compose finds them and does not
  rebuild), unpacks the models into a local dir, and prints the bring-up
  commands. Bring-up is `docker compose up -d --no-build` — the one rule is
  *never* `--build`, which is the only thing that would reach for npm/a
  registry off-network. `docker-compose.ollama.yml` now takes an
  `AEGIS_OLLAMA_MODELS` override so the model mount points at the unpacked
  bundle dir instead of a `~/.ollama` the target doesn't have.

Verified non-destructively: the bundle's models were unpacked into an
isolated temp dir and served by a throwaway Ollama container mounting *only*
that dir (no host `~/.ollama`) — `ollama list` showed exactly the two models
and a real inference ran (proving the blobs are complete, not just
manifest-visible). The definitive test — `load` onto a physically
disconnected box and bring the whole stack up — needs a spare/wiped machine,
so it's documented in `deploy/offline/README.md` rather than run against the
live demo. The bundle output (`aegis-offline-bundle/`, ~7.3 GB) is
gitignored; the tooling and `images.list` are tracked.

## 13. Files changed

| File | Purpose |
|------|---------|
| `.env` (gitignored, not committed) | Sandbox settings per §2; `ARCHON_KEYMASTER_GATEKEEPER_URL`, `ARCHON_DRAWBRIDGE_PUBLIC_HOST`, `ARCHON_CLN_VERSION` per §9; `ARCHON_DIDCOMM_URL` per §11 |
| `docker-compose.override.yml` | Internal-only network, §3; `didcomm` private-egress opt-in, §11 |
| `packages/clients/src/keymaster-types.ts` | Add `verifyProof` to `KeymasterInterface` |
| `packages/clients/src/keymaster-client.ts` | Implement `verifyProof` over `POST /keys/verify` |
| `docker-compose.lightning-regtest.yml` | Stretch goal: regtest bitcoind + 2x LND, §8 |
| `docker-compose.lightning-zap.yml` | Stretch goal: CLN + LNbits + Drawbridge zap flow, §9 |
| `scripts/sandbox/cln-lightningd-wrapper.sh` | Fix vendor CLN image's broken config generation, §9 |
| `docker-compose.ollama.yml` | Containerized Ollama for Hearthold's classifier, §11; `AEGIS_OLLAMA_MODELS` mount override for the offline bundle, §12 |
| `deploy/offline/` | Air-gapped pack/load bundle tooling + `images.list` + README, §12 |
| `AEGIS.md` | Fork framing / overlay guide (repo landing) |
| `data/.gitignore` | Added `regtest-lightning/` |
| `SANDBOX-PROFILE.md` | This document |

To tear down: `docker compose --env-file .env down` (add `-v` to also drop
the `data/mongodb` and `data/redis` volumes; DID state, wallets, and IPFS
blocks all live under `./data/`, which is not touched by `down` alone).
Tear down the Lightning stretch goals separately per §8/§9, and the
DIDComm/Ollama add-ons per §11.
