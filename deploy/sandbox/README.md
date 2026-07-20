# Hearthold in the offline Archon sandbox

Runs Hearthold's agents (Warden / Emissary / Sovereign) as containers on the **egress-isolated
`archon_default`** network created by the Archon sandbox (`~/isolation/archon`, `internal: true`),
against the Archon node reached by container hostname at `http://drawbridge:4222`. Image build uses
the internet; **nothing needs network at runtime** — proven below.

Scope: the manual two-terminal spine from `docs/manual-testing.md §3` — Warden init → delegate → serve,
Emissary init → submit, Warden vault. Not the full `e2e:*` suite (evidence graphs, KB spaces, CGPR,
trust registry) — that's follow-on work.

## Files

| Path | What |
|---|---|
| `Dockerfile` (repo root) | Builds Hearthold (`npm ci && npm run build`) on `node:22-bookworm`; idles at runtime |
| `docker-compose.hearthold.yml` (repo root) | Joins `archon_default` (`external: true`); warden/emissary/sovereign as idle containers we `exec` into |
| `.dockerignore` (repo root) | Keeps `node_modules`/`dist`/`*.tsbuildinfo` out of the build context |
| `.env` (repo root, gitignored) | `HEARTHOLD_PASSPHRASE` for compose substitution — copy from `.env.example` |
| `deploy/sandbox/run-demo.sh` | **Full contained walkthrough** — preflight, isolation proof, provisioning, then the TUI handoff (`reset` to wipe) |
| `deploy/sandbox/run-spine.sh` | Drives the spine + egress proof, printing every DID/receipt |
| `deploy/sandbox/run-prove.sh` | Prove flow — issue a credential + verifier; drive the Signet (setup/signet/verify) |
| `deploy/sandbox/run-signet-tui.sh` | Signet TUI (`packages/signet-tui`) — approvals, over the localhost control plane |
| `deploy/sandbox/run-emissary-tui.sh` | Emissary TUI (`packages/emissary-tui`) — submit observations |

## Prerequisites

The Archon sandbox is up with the `didcomm` (and drawbridge) profile, and two settings are in place
(see **DIDComm endpoint** below):

```bash
docker network inspect archon_default --format 'internal={{.Internal}}'   # → internal=true
curl -s http://<sandbox-host>/... not needed — verify from a container instead:
docker run --rm --network archon_default curlimages/curl -s http://drawbridge:4222/api/v1/capabilities
#   → {"didcomm":true,"lightning":true,"names":true}
```

## Bring it up

```bash
cd ~/hearthold
cp .env.example .env          # then set HEARTHOLD_PASSPHRASE (sandbox dev value; not a secret)
docker compose -f docker-compose.hearthold.yml up -d --build   # first run: --build (shared image)

./deploy/sandbox/run-spine.sh # egress proof + the full spine, with the transcript
# or:  ./deploy/sandbox/run-spine.sh --egress-only | --spine-only

docker compose -f docker-compose.hearthold.yml down            # tear down (state persists in ./data)
```

Each agent's wallet/vault/index persists to `./data/<role>` (bind mount, Archon's `./data` convention).
`warden serve` runs as a detached `exec` inside the warden container; the others are one-shot `exec`s.

## Config (this pass)

| Var | Value | Why |
|---|---|---|
| `HEARTHOLD_NODE_URL` | `http://drawbridge:4222` | The node by container hostname (not a host port — those don't work under `internal: true`) |
| `HEARTHOLD_REGISTRY` | `local` | The offline node's DB-only registry |
| `HEARTHOLD_OLLAMA_URL` | `http://ollama:11434` | On-device classification (`qwen3:8b`) + recall embeddings (`nomic-embed-text`) via the sandbox's `ollama` container — no egress. (Unset `HEARTHOLD_CLASSIFIER` ⇒ `ollama` mode; set it to `quarantine` to seal everything to SEALED instead.) |
| `HEARTHOLD_PASSPHRASE` | from `.env` | Unlocks each agent's wallet; sandbox dev value, never committed |
| `HEARTHOLD_DIDCOMM_ENDPOINT` | `http://drawbridge:4222/didcomm` | See **DIDComm endpoint** |

## Registry — why `local` works here

Challenge/response (auth + VP) DIDs are **ephemeral**; keymaster hardcodes their registry to `hyperswarm`
and does *not* inherit `defaultRegistry`, so on an offline node they'd fail with an opaque "Upstream
gatekeeper error". Hearthold sets the keymaster instance's `ephemeralRegistry` to `config.registry`
(`packages/core/src/keymaster.ts`), so with `HEARTHOLD_REGISTRY=local` **every DID — identity and
ephemeral — anchors on `local`**, the node's DB-only registry (never queued to any mediator). This is
what makes the offline node work end-to-end; no registry switch on the node is needed.

## DIDComm endpoint — the one thing that needed a node-side change

DIDComm delivery resolves the *recipient's* published `DIDCommMessaging` service endpoint and the relay
**dials it** (`services/didcomm/server/src/didcomm-api.ts` `POST /deliver` → `<endpoint>/api/v1/messages`).
Two facts collided:

1. The node advertises `https://sandbox.archon.local/didcomm` from `/api/v1/didcomm-endpoint` (its
   `ARCHON_DRAWBRIDGE_PUBLIC_HOST`) — a **non-resolving symbolic host** deliberately reserved for the
   **Lightning** mediator's string-compare loopback (`lightning-mediator.ts:509-519`). The DIDComm relay
   has **no such loopback** — it genuinely dials the endpoint — so publishing that host makes every
   `submit` fail `502` (host unreachable). (This was the "assumed the dummy wasn't used" gap: it isn't
   used by Lightning's dial, but DIDComm *does* dial it.)
2. The relay's `/deliver` SSRF-guards clearnet delivery to **https-only + non-private hosts**, so
   pointing agents at the in-network `http://drawbridge:4222/didcomm` instead fails `400`
   "private/loopback endpoint not allowed".

Fix — two minimal, isolation-preserving changes:

- **Hearthold** (`packages/core/src/transport.ts`): a new `HEARTHOLD_DIDCOMM_ENDPOINT` env overrides the
  endpoint an agent publishes, so agents advertise the address reachable *in-network*
  (`http://drawbridge:4222/didcomm`) instead of the node's external/dummy host. Default (unset) is
  unchanged — the node's advertised endpoint.
- **Node** (`~/isolation/archon/docker-compose.override.yml`, added to the `didcomm` service):
  `ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS=true` — lifts the *app-level* SSRF guard so the relay may dial the
  private in-network `drawbridge` host. **Isolation is NOT weakened**: the network is still
  `internal: true`, so the relay can reach `drawbridge` on-network but a dial to any public IP still
  `ENETUNREACH`es. This is the documented dev pattern (`docs/manual-testing.md` uses the same flag).

`ARCHON_DRAWBRIDGE_PUBLIC_HOST` is left untouched (Lightning depends on it).

## Sovereign Signet & the prove flow

The Signet is the Sovereign's proof-of-human gate — it fields proof-requests and co-signs disclosures,
approving each with a PIN. In this isolated environment it runs as an **interactive** `sovereign serve`
(terminal PromptGate); the browser Signet Approver (`sovereign control` on `:4311`) can't be used because
`internal: true` blocks published host ports.

`deploy/sandbox/run-prove.sh` wires a demonstrable end-to-end prove flow — a guild manager (a distinct
issuer identity under `/data/guild-manager`) issues a `GuildMembership` to the Sovereign, and a verifier
challenges the Sovereign to prove it holds one:

```bash
./deploy/sandbox/run-prove.sh setup        # one-time: issuer + credential + verifier (idempotent)
# then, in TWO terminals:
./deploy/sandbox/run-prove.sh signet 1379  # A — the Signet: waits, prompts for the PIN on each disclosure
./deploy/sandbox/run-prove.sh verify       # B — verifier requests → the Signet prompts in A
#   type the PIN in A to approve → B prints ✓ VERIFIED (role=Raid-Lead, issued by the guild manager);
#   blank denies. Trust rests on the ISSUER's signature, not the Warden's.
```

PIN handling: `signet [pin]` passes `HEARTHOLD_SIGNET_PIN` via `exec -e` (per-session); or set it in the
gitignored `.env`. Never the committed compose. The `sovereign` + `verifier` containers are in the compose.

### Signet TUI (the terminal front-end)

For a richer, browser-free approval UI, `deploy/sandbox/run-signet-tui.sh` runs the **Signet TUI**
(`packages/signet-tui`) — an Ink (React-for-the-terminal) port of `apps/signet-approver`. It reuses the
exact control-API contract (`@hearthold/control-types`, `GET /api/snapshot`, `POST /api/approve`); only
the render layer differs (DOM → terminal). Architecturally option (a): the TUI is a client of the
Sovereign's localhost control plane (`sovereign control` on `127.0.0.1:4311`, never published to the
host); the helper starts that daemon and the TUI together, so it's one command.

```bash
./deploy/sandbox/run-signet-tui.sh 1379    # terminal A — live pending-approvals view; ↑/↓ · a · d · q
./deploy/sandbox/run-prove.sh verify       # terminal B — a proof-request appears in A; 'a' + PIN approves
```

The masked PIN is entered in the TUI and checked by the daemon's `HttpGate` (same as the browser app).

## Egress isolation (the load-bearing property)

`run-spine.sh` proves it before the spine; each agent container, direct-IP (no DNS):

```
warden:    OK isolated — ENETUNREACH (connect ENETUNREACH 1.1.1.1:80)
emissary:  OK isolated — ENETUNREACH
sovereign: OK isolated — ENETUNREACH
warden dns: OK isolated — DNS EAI_AGAIN
```

A public host is unreachable and DNS does not resolve — the agents can talk to `drawbridge` on-network
and nothing else.
