# Deploying the private "agency" KB (David's corpus) on megaflax — host-native, loopback-first

A **private, member-gated** KB of David's *Architecture of Agency* corpus (9 volumes, ~1366 passages),
served by a single-purpose **KB Warden + kb-web Mage** pair running **host-native** on megaflax (M1 Max Mac
→ macOS LaunchAgents). **Bound to 127.0.0.1 only.**

## Why host-native, not containerized (Aegis measured this)
On this M1 Max, the two requirements sit on opposite sides of the seal:
- the **Archon gatekeeper** resolves only INSIDE `aegis_internal` (internal:true), and
- the **GPU** is reachable only on the HOST — Docker-on-macOS has no Metal passthrough, so a container's
  Ollama runs on CPU at ~0.2 tok/s (a `qwen3:8b` thinking answer would take **tens of minutes** — unusable).

You can't have both from one side. The fix is the pattern already running here: a **`tcp-forward` bridge**
for the node, so a host-native process reaches the sealed node over loopback while using the host's GPU Ollama.

## Build-host prerequisites (Aegis)
- **Internet** on the build host — the run crawls `https://axionic.org` for the corpus (a sealed-net-only
  process can't fetch it; that's the *second* reason host-native is required, alongside the GPU).
- **Loopback to the node** for the mints (via the bridge below).
- **`HEARTHOLD_NODE_URL` MUST be explicit.** Unset, it defaults to `flaxlap.local:4222` — a *different node*.
  Set it to the agent-window (`http://127.0.0.1:4296` — see the corrected node-front prereq below), or the
  mints land on the wrong node.
- **`AGENCY_DAVID`** — a sealed node can't resolve a `name@domain`, so pass David's raw DID:
  `AGENCY_DAVID=did:cid:bagaaierar7rd7vkb5aq4ie4wzdlfpcxthvsi6q4uspn6zopy5amthleslyza` (his doc IS resolvable
  on the sealed node; only the name lookup isn't). Off a sealed node, the `cypher@4tress.org` name default works.

## Prereq — the node front (Aegis, do this FIRST)

> **CORRECTED 2026-08-29 — use the `agent-window` at `127.0.0.1:4296`, NOT `4299`.** Aegis brought up the
> `agent-window` (live, proven end-to-end: a host-native Warden+Emissary complete a DIDComm login + cited
> oracle answer through it in ~9s). It answers `/api/v1/didcomm-endpoint` itself (so endpoint auto-discovery
> publishes a real endpoint), and it pins `/deliver` to the node's own mailbox. The old `4299` bridge reaches
> an **admin-keyed gatekeeper** (enumerate/export ungated, destructive routes with the key attached) — do not
> point the agency mints at it. The exact window bring-up is Aegis's; the env values below are corrected, but
> reconcile the surrounding steps with his current setup before the stand-up.

The pair runs host-native with these env values (in the 0600 env files):
- `HEARTHOLD_NODE_URL=http://127.0.0.1:4296`   — the sealed node via the **agent-window** (loopback)
- **no `HEARTHOLD_DIDCOMM_ENDPOINT`** — auto-discovery is correct now that the window answers the lookup
- `HEARTHOLD_OLLAMA_URL=http://127.0.0.1:11434` — the **HOST** Ollama (GPU, `qwen3:8b` already resident)
- `HEARTHOLD_ANSWER_MODEL=qwen3:8b`, `HEARTHOLD_REGISTRY=local` (this node's gatekeeper accepts `local`)

Members: owner + **David** (`cypher@4tress.org` → `did:cid:bagaaierar7rd7vkb5aq4ie4wzdlfpcxthvsi6q4uspn6zopy5amthleslyza`).

## ⚠️ Two things to know
1. **~20–30s per answer, by design** — `answerThink:true` + `qwen3:8b` (a book deserves a reasoning pass);
   the intended trade, not a regression. `answerThink:false` / a smaller model makes it fast.
2. **Shared GPU with the mages KB.** This uses the HOST Ollama — the same instance serving the online
   (mages) KBs over the tailnet. A long book-thinking answer contends with mages queries: shared capacity,
   not dedicated. Watch it; if book queries ever slow mages, give the book a dedicated instance or a
   no-think/smaller answer model.

## Env files (0600, under `~/.hearthold-agency/`)
- `.env.agency-warden`: `HEARTHOLD_PASSPHRASE`, `HEARTHOLD_DATA_ROOT=~/.hearthold-agency-warden`,
  `HEARTHOLD_REGISTRY=local`, `HEARTHOLD_ANSWER_MODEL=qwen3:8b`, `HEARTHOLD_NODE_URL=http://127.0.0.1:4296`,
  `HEARTHOLD_OLLAMA_URL=http://127.0.0.1:11434`, `HEARTHOLD_APP=<repo path>`, `HEARTHOLD_NODE=<node bin>`,
  and on a sealed node `AGENCY_DAVID=did:cid:…thleslyza` (David's DID — a name can't resolve there).
- `.env.agency-kb-mage`: same passphrase/model/node/app/URLs, `HEARTHOLD_DATA_ROOT=~/.hearthold-agency-kb-mage`,
  and `HEARTHOLD_WARDEN_DID=<the agency Warden did>` (filled after Step 1).

## Step 1 — build the KB (host-native; grants membership) — **flaxscrip's DIRECT go to Aegis**
> Grants read membership on a real person's DID (David). Runs host-native (npm), NOT in a container.
```sh
set -a; . ~/.hearthold-agency/.env.agency-warden; set +a
cd "$HEARTHOLD_APP"
npm run build:agency-kb          # full corpus, kbId "agency" (~60s); resolves David + grants read to owner+David
# copy the printed Warden did into .env.agency-kb-mage as HEARTHOLD_WARDEN_DID.
```
It ends by verifying a member query through the challenge/response wall (reasoned, ~20–30s).

## Step 2 — serve (loopback), Warden first
```sh
mkdir -p ~/.hearthold-agency
cp "$HEARTHOLD_APP/deploy/agency/"*.plist ~/Library/LaunchAgents/     # adjust the paths inside each plist
launchctl load -w ~/Library/LaunchAgents/com.hearthold.agency-warden.plist
launchctl load -w ~/Library/LaunchAgents/com.hearthold.agency-kb-mage.plist   # after the Warden did is wired
```

## Step 3 — verify (loopback)
```sh
tail -f ~/.hearthold-agency/agency-warden.err     # "Warden serving over DIDComm … serving … agency"
tail -f ~/.hearthold-agency/agency-kb-mage.err    # "KB Portal … relaying to Warden …"
curl -s http://127.0.0.1:4313/ | head             # the Mage on host loopback
ollama ps                                          # host Ollama: qwen3:8b + nomic resident (GPU)
```

## The endpoint (deferred)
Don't expose speculatively. At handoff: archon-ops's nginx proxying megaflax over the tailnet (as
`sovereign.archon.technology` already does), or hand David a self-contained bundle — `vault.json`+`index.json`
(portable) PLUS the config DIDs (which must RESOLVE on his node: rebuild the config on `hyperswarm`, or export
the config DIDs alongside the files, and **test on a fresh host**).

## Rollback
```sh
launchctl unload -w ~/Library/LaunchAgents/com.hearthold.agency-kb-mage.plist
launchctl unload -w ~/Library/LaunchAgents/com.hearthold.agency-warden.plist
# KB data is self-contained under ~/.hearthold-agency-warden — remove to fully undo.
```
