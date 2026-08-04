# `aegis` — operator CLI for a secured Archon node

A small, human-usable interface for **running and using** an egress-isolated Aegis
node once it's up. Bring-up lives elsewhere (`deploy/node/install.sh`, `deploy/node/setup-node.sh`,
`start-node`, `SANDBOX-PROFILE.md`); this is the layer on top that a person actually
touches during a demo or hackathon.

## The one rule it enforces

The node's containers sit on an **internal-only Docker network with no egress**. Client
tools must **never join that network** — a client has no business on the gatekeeper/IPFS
plane. So every command here reaches a daemon **only through its host-published loopback
bridge** (`127.0.0.1:<port>`), exactly like a browser does. No command ever passes
`--network <node-network>`. This is the correct, safe pattern; it's baked in so an
operator can't get it wrong.

## Install

```bash
# put them on PATH (or call by full path)
ln -s "$PWD/deploy/node/operator/aegis"        /usr/local/bin/aegis          # client CLI  (or ~/.local/bin)
ln -s "$PWD/deploy/node/operator/aegis-wallet" /usr/local/bin/aegis-wallet   # admin wallet CLI (see below)
ln -s "$PWD/deploy/node/operator/aegis-mcp"    /usr/local/bin/aegis-mcp      # agent-Sovereign MCP launcher (see below)
cp deploy/node/operator/aegis.env.example deploy/node/operator/aegis.env   # then edit for this node
```

Config search order: `$AEGIS_CONFIG` → `./aegis.env` (next to the script) → `~/.aegis.env`.

## v1 commands

### `aegis status`
Node health + **isolation posture** — the trust anchor for a hackathon. Reports:
- running node containers; the loopback control bridges of the **triad**
  (Warden `:4310` / Signet `:4311` / Emissary `:4312`) and `require-session` posture;
- **Roles & vault**: the Warden's identity + vault size + assurance ladder (read via
  `warden status`, no session), Sovereign resolution, and the Emissary's identity + which
  Warden it submits to, and the **ingestion-gate threshold** (quarantine posture — green at the
  safe SEALED default, a warning if relaxed). (Delegation/authorization state is session-scoped,
  so it's noted, not asserted — check it logged in.)
- **Agents & MCP**: the node-env agents (`aegis`/`sevenfold`/`hearthold`) and their parent, plus whether the
  `hearthold:agent-mcp` image is built — a pointer to `aegis-mcp <agent> check`/`config`/`build` (local read only;
  the actual in-network launch lives in the sibling `aegis-mcp`).
- the **isolation proof**: from inside an internal node container it attempts an
  outbound TCP connect to `1.1.1.1:443` and confirms it **fails** (`ENETUNREACH`), plus
  IPFS swarm peers = 0. A green egress-blocked line is proof the node can't reach the
  internet at runtime — not just a claim in a doc.

```
$ aegis status
  ...
  Isolation proof — egress from inside the node must FAIL
  ✓ egress BLOCKED from aegis-didcomm-1 → 1.1.1.1:443 (ENETUNREACH) — isolation intact
  ✓ IPFS swarm peers: 0 (aegis-ipfs-1) — no bulk gossip
```
(Set `AEGIS_GATEKEEPER_URL` to enable the DID-resolution check; `AEGIS_PROOF_CONTAINER`
to pin which container the egress test runs from.)

### `aegis table [up|build|serve|down|status]`
The Sevenfold Table — a browser client that drives the Warden control API.

- **On a dev box** (has the source + `npm`): `aegis table up` builds a live-datasource
  bundle for the local Warden, then serves it on `127.0.0.1:5175`.
- **On the node** (no source; a copied bundle): set `AEGIS_TABLE_DIST` to the copied
  `dist/` and run `aegis table serve`. Browse `http://localhost:5175` **on the node**.

Cross-node flow (build where the source is, serve where the node is):
```bash
# dev box:
AEGIS_TABLE_SRC=~/Documents/Projects/Sevenfold/apps/table \
AEGIS_SOVEREIGN_DID=<node-sovereign-did> aegis table build
scp -r "$AEGIS_TABLE_SRC/dist"/* node:/path/to/table-dist/
# node (aegis.env: AEGIS_TABLE_DIST=/path/to/table-dist):
aegis table serve
```

### `aegis signet [extract]`
The Signet approver TUI — used to approve logins and step-ups (PIN entered
interactively). It talks to the Signet daemon via the loopback bridge.

```bash
aegis signet            # launch (native if a bundle+node exist, else a --network host container)
aegis signet extract    # one-time: lift the TUI bundle out of the image for the fast native path
```

`--network host` is used only so the container can reach `127.0.0.1:<bridge>`; it does
**not** join the node's internal network. Prefer the native path (`signet extract` +
`AEGIS_SIGNET_TUI_JS`) when a host `node` is available.

### `aegis model [list | roles | pack <name> [outdir] | import <tarball> | verify <name>]`
The node's on-device Ollama models — the AI substrate (classify, embed, answer, and — pending — vision).
Model **selection and staging are Aegis's job**; Hearthold just consumes the configured model names.

```bash
aegis model roles                 # the check that catches a missing model in one line:
#   ✓ classify  qwen2.5:3b — present
#   ✓ embed     nomic-embed-text — present
#   answer     (inherits classify)
#   vision     <unset> — not configured (image support pending)
aegis model list                  # everything in the node's Ollama
aegis model verify nomic-embed-text   # prove it answers (from a node container — the Ollama image has no curl)
```

**Staging a model onto an air-gapped node** (the node can't pull; do it in two halves, like `table build`/`serve`):
```bash
# connected box (has internet + ollama):
aegis model pack moondream /tmp        # → /tmp/moondream-latest.ollama.tgz (pull + package)
# node:
scp /tmp/moondream-latest.ollama.tgz node:/tmp/
aegis model import /tmp/moondream-latest.ollama.tgz   # extract into the Ollama store; no restart
aegis model verify moondream
```
This is the same manifest+blobs transfer the offline bundle does, as a command. `aegis model roles` is what would
have surfaced the earlier missing-embedder gap immediately.

## Offline / air-gapped

The `aegis` CLI is designed to run on a **fully egress-isolated node** — the isolation
*is* the test, so nothing here reaches a registry or the internet. Verified against a live
isolated node:

| Dependency | Offline status |
|---|---|
| Tooling (`python3`, `node`, `docker`) | local, on the node |
| `hearthold:sandbox` image | present locally → `docker run/create/cp` **never pulls** |
| Table `dist`, extracted TUI bundle | local artifacts, no fetch |
| Network calls | **loopback only** (`127.0.0.1:<bridge>`) — no egress |
| Served Table bundle | self-contained (bundled JS/CSS; no remote fonts/CDN/scripts) |

**The split that makes this work:** the only step that needs the network is
`aegis table build` (it runs `npm`/Vite). That is a **connected-dev-box step**. The
air-gapped node runs only `table serve` and `signet`, which touch nothing external.

Command-by-command:

| Command | Needs network? |
|---|---|
| `aegis table build` | **yes** — run on a connected dev box, then ship the `dist` |
| `aegis table serve` / `down` / `status` | no — `python3` static serve on loopback |
| `aegis signet` / `signet extract` | no — local image + local bundle, loopback connection |
| `aegis help` / `version` | no |

**End-to-end air-gap flow** (pairs with `deploy/offline/`):

```bash
# 1) connected dev box: build the Table bundle + capture the image
aegis table build                                   # → apps/table/dist
deploy/offline/pack-offline-bundle.sh               # → image + assets tarball

# 2) carry the bundle + dist across the air gap (USB, one-way transfer, …)

# 3) isolated node: load, configure, run — no network from here on
deploy/offline/load-offline-bundle.sh               # docker load hearthold:sandbox
#   set AEGIS_TABLE_DIST to the copied dist in aegis.env
aegis table serve      # http://localhost:5175, loopback only
aegis signet           # approver TUI, loopback only
```

**Ollama models (the easy thing to forget).** The node's on-device AI needs **two** local Ollama
models — the **classifier** (`qwen2.5:3b`) *and* the recall/KB **embedder** (`nomic-embed-text`) — and an
air-gapped node **cannot pull them**. `pack-offline-bundle.sh` stages *both* (`ollama-models.tar.gz`) and the
loader unpacks them, so a bundle-provisioned node is complete. If a node was set up piecemeal and is missing
one (symptom: classification works but `/api/recall` returns nothing — the embedder is absent), stage it in
by hand — pull on a **connected** box, then copy the model into the node's Ollama store:

```bash
# connected box (its HOST ollama has internet; the isolated containers do not):
ollama pull nomic-embed-text
cd ~/.ollama/models
# tar the manifest + its blobs (digests are in the manifest JSON; ':' → '-' in blob filenames):
tar czf /tmp/nomic.tgz manifests/registry.ollama.ai/library/nomic-embed-text/latest blobs/sha256-<config> blobs/sha256-<layers…>
# isolated node — extract into Ollama's models dir (often a bind mount; no restart needed):
#   scp /tmp/nomic.tgz node:/tmp/ ; tar xzf /tmp/nomic.tgz -C <ollama models dir>
```
Verify from a node-capable container (the Ollama image has no `curl`):
`docker exec <warden> node -e 'fetch("http://ollama:11434/api/embeddings",{method:"POST",body:JSON.stringify({model:"nomic-embed-text",prompt:"x"})}).then(r=>r.json()).then(j=>console.log(j.embedding.length))'` → `768`.

**Environment note:** the CLI targets the daemons' host-published **loopback bridges**.
These work on a **Linux** node (the NayaOne-style hackathon target). On macOS Docker
Desktop, `internal: true` also blocks *published* host ports (`SANDBOX-PROFILE.md` §3), so
the loopback bridges aren't reachable there — that's a dev-workstation caveat, not part of
the isolated deployment path.

### `aegis config [show | require-session <on|off|status> | signet-pin <show|set PIN> | ingest-threshold <show|set LEVEL>]`
Flips the control-overlay knobs without the edit-env-then-recreate dance. It edits the
node's control env file and recreates the affected daemon(s).

```bash
aegis config show                       # posture: require-session + PIN set? + ingestion threshold
aegis config require-session on         # gate all scoped routes behind login (recreates + verifies 401)
aegis config require-session status
aegis config signet-pin show            # reveal the current PIN (your own tool, your own node)
aegis config signet-pin set 4242        # set + recreate the Signet daemon (new PIN live immediately)
aegis config ingest-threshold show      # current quarantine threshold (default SEALED = quarantine all)
aegis config ingest-threshold set MEDIUM  # relax: only PUBLIC/LOW/MEDIUM quarantine; HIGH/SEALED auto-file
```

**Ingestion gate** (`ingest-threshold`, Hearthold `HEARTHOLD_CONFIRM_AT_OR_BELOW`): a delegated
Emissary's submission whose sensitivity is at/below the threshold is **quarantined into triage** and
kept **inert** (not recall/KB-searchable) until the Sovereign confirms. The default `SEALED` quarantines
*everything* — the safe posture (an agent may propose; only the Sovereign admits). Lowering it auto-admits
higher tiers. See `SOVEREIGN-DATA-SECURITY.md` §9 (mechanism 13).

Requires these in `aegis.env` (per node):
```
AEGIS_CONTROL_ENV=$HOME/.control-gamer.env
AEGIS_CONTROL_COMPOSE=/path/to/deploy/node/topology/docker-compose.control.yml
#AEGIS_CONTROL_PROJECT=aegis-control      # default
```
Note: `require-session on` needs the compose to pass `HEARTHOLD_REQUIRE_SESSION` through
to the daemon env (the command warns if it doesn't).

## `aegis-wallet` — admin wallet access (without exposing the gatekeeper)

A **separate** tool (`deploy/node/operator/aegis-wallet`) for a **different** job: running the Keymaster CLI against a
wallet — which genuinely needs the gatekeeper. The gatekeeper lives on the sealed network and is **never published
to the host**. Rather than punch the port out, `aegis-wallet` runs keymaster in an **ephemeral container that joins
the sealed net for the command's lifetime and exits** — the same shape as `docker compose exec gatekeeper …`: admin
access through a container, not a host port.

This is the deliberate **admin** exception to the one rule above. `aegis` is client-only and never joins the node
network; wallet ops are admin and legitimately need the gatekeeper, so they get a scoped in-network run — with a
guard that **refuses any network that isn't `internal:true`**.

```bash
aegis-wallet <member> <keymaster-command> [args...]
#   member: aegis | sevenfold | hearthold   (the node-env AGENTS; or a path under the data root)

aegis-wallet aegis resolve-id                # → the agent's DID (resolved via the sealed gatekeeper)
aegis-wallet sevenfold list-ids              # → the agent's id name
aegis-wallet hearthold decrypt-did <cardDID> # → read a card passed to this agent
aegis-wallet aegis help                      # full keymaster command list
#   parent/sovereign/warden are node-managed identities → refused; see ~/aegis-env/node/ENVIRONMENT.md
```

- **Passphrase** precedence: `AEGIS_WALLET_PASS` → `FAMILY_PASSPHRASE` in `deploy/node/family/family.env` → ambient
  `ARCHON_PASSPHRASE`. `family.env` **wins over** an ambient `ARCHON_PASSPHRASE` so a node/MCP passphrase in your
  shell can't shadow the agent wallets. The secret is passed via a shredded temp `--env-file`, never the command line.
- **Overrides:** `AEGIS_FAMILY_DATA` (identity store root, default `~/aegis-env/node/data/identities`), `AEGIS_NET`
  (default `aegis_internal`), `AEGIS_KM_IMAGE` (default `hearthold:sandbox`), `AEGIS_GATEKEEPER_URL` (default
  `http://gatekeeper:4224`).

## `aegis-mcp` — launch a bound agent-Sovereign MCP (in-network, gatekeeper unpublished)

A **third** tool (`deploy/node/operator/aegis-mcp`), sibling to `aegis-wallet`, for the newest job: running Hearthold's
agent-as-Sovereign MCP (`@hearthold/agent-mcp`) **bound to a node-env agent**. The MCP server needs the gatekeeper, so
— like `aegis-wallet` — it runs in an **ephemeral container on the sealed net**; an MCP client on the host drives it
over `docker run -i` stdio. **Server-in-sealed-net, client-on-host — the gatekeeper is never published.** Same
`internal:true` guard.

```bash
aegis-mcp build                 # (re)build the linux-native image hearthold:agent-mcp (needs the agent-mcp package)
aegis-mcp aegis check           # binding probe → "✓ aegis binds as did:cid:…"
aegis-mcp aegis config          # print an MCP-client config snippet ({ mcpServers: { hearthold-aegis: … } })
aegis-mcp aegis                 # RUN the bound server over stdio (this is what an MCP client spawns)
#   agent: aegis | sevenfold | hearthold   (node-env agents; or a raw wallet path)
```

- Wire it into any MCP client by pasting `aegis-mcp <agent> config` into the client's `mcpServers`. The client spawns
  `aegis-mcp <agent>`; every `hearthold_*` tool then acts **as that agent** — `hearthold_read_card(did)` replaces the
  old six-env-var keymaster script.
- **Read-ish slice** (`whoami`, `read_card`) needs only the bound wallet + gatekeeper. **Facade verbs**
  (`list_inbound`, `pass_card`, `accept_card`, `recall`, …) hit the agent's Warden plane — **auto-wired**: if the
  agent's `<agent>-agent-warden` plane is up (see `docker-compose.agent-wardens.yml`), `aegis-mcp <agent>` sets the
  Warden URL for you. Override with `AEGIS_MCP_WARDEN_URL` (`/_SIGNET_URL`/`_EMISSARY_URL`); explicit always wins.
- **Why a standalone image:** `@didcid/mcp-server` pulls a native `sqlite3`, so a host-mounted macOS `node_modules`
  won't run in the linux net. `hearthold:agent-mcp` (built by `aegis-mcp build`, Dockerfile in `operator/agent-mcp/`)
  carries the linux binaries; `agent-mcp` has no `@hearthold` workspace deps, so it installs clean from the registry.
- **Overrides:** `AEGIS_NODE_ENV_DATA` (default `~/aegis-env/node/data`), `AEGIS_AGENT_MCP_IMAGE`, `AEGIS_AGENT_MCP_SRC`
  (build source, default `~/hearthold/packages/agent-mcp`), plus the `AEGIS_WALLET_PASS`/`family.env` passphrase chain.
- **Limitation:** `create-challenge`/`create-response` fail `non-local` for `local`-anchored identities (keymaster's
  ephemeral registry is hardcoded to `hyperswarm`). Identities that must do manual CLI challenge/response need to be
  on private-hyperswarm; Hearthold's Signet handles the challenge internally and is unaffected.

## Roadmap (next commands)

- `aegis login` — challenge → `create-response` (correct gatekeeper URL) → submit.
- `aegis cards [list|accept <did>]` — day-to-day card operations under a proven session.
- `aegis config require-session <on|off>` — the login-gate toggle.

## Notes

- **Login gate:** if the node has `HEARTHOLD_REQUIRE_SESSION=true`, the Table renders a
  login screen; approve via the Signet TUI (PIN) or a Keymaster `create-response`.
- **Passphrase/PIN** live in the node's control env (e.g. `~/.control-gamer.env`), never
  in this tool.
