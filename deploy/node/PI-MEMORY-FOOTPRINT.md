# Aegis pi-lean Sovereign node — 8 GB memory footprint

**Host:** Raspberry Pi 5, 8 GB, Debian 13 (trixie), `aegis.local`
**Storage:** salvaged USB flash drive (Silicon Motion `090c:2320`) — UAS bridge quirked to `usb-storage`
(`usb-storage.quirks=090c:2320:u`), genuine 467 GB (f3probe-confirmed), fresh ext4. Docker + containerd
data-root relocated onto it. **8 GB swap on the SD boot drive** (`/var/swap` 2 G + `/swapfile` 6 G) — none on
the cheap flash, so it's out of the write path.
**Image:** `hearthold:invocation` — **built on the Pi** (ARM), 2.73 GB.
**Isolation:** PROVEN — egress from a node container fails `ENETUNREACH`, DNS fails `EAI_AGAIN`,
`aegis_internal` is `internal:true`.
**Note:** cgroup memory controller is disabled (`cgroup_disable=memory`, a Pi OS default) so `docker stats`
reports 0 B — per-container figures below are host-process RSS. A graphical desktop (`labwc`/panel/`pcmanfm`,
~370 MB) is running; a console-only boot would reclaim it.

## Measured (all with 0 swap used)

| Stage | mem used | available | notes |
|---|---|---|---|
| Baseline (desktop, no node) | ~535 MB | 7.5 GB | idle Pi + desktop |
| **Build peak** (npm ci + tsc + docker build, ARM) | **1,698 MB** | 6,359 MB | 72 samples / 36 min, **never swapped** |
| Node core (7 archon svcs) | ~1,033 MB | 7,024 MB | cli,didcomm profiles |
| Full stack (node core + custodian, 11 containers) | 1,339 MB | 6,718 MB | modernized Warden+Signet daemons |
| **Full stack + AI model loaded** (12 containers) | **3.5 GiB** | **4.4 GiB** | qwen2.5:3b resident 2.4 GB; swap 250 MiB (clean — after clearing tmpfs tarballs) |

## Per-container (host RSS)

**Node core (565 MB):** mongodb 175 · gatekeeper 114 · keymaster 105 · didcomm 87 · ipfs 64 · redis 19 · cli 1
**Custodian (398 MB):** warden 162 · signet 136 · warden-bridge 50 · signet-bridge 50
Sum of container RSS ≈ 963 MB; the balance to 1,339 MB is host + desktop overhead.

## The modernized custodian (invocation-daemon model)

`deploy/node/topology/docker-compose.pi-sovereign.yml` — successor to the old "idle agents" compose. Warden
(`:4310`) + Signet (`:4311`) real control daemons on `hearthold:invocation`, COMPAT posture, loopback bridges.
pi-lean has no drawbridge, so the node path is the gatekeeper **directly** (`http://gatekeeper:4224`) — confirmed
working (a `sovereign init` `createId` anchored on the local registry through it, no admin-injection needed).
Measurement Sovereign: `did:cid:bagaaiera26lbpx63pelkhyjtfnwuawubgupjpda4azmhljxj3exc7inw3fva` (throwaway
passphrase in a mode-600 file; the real Sovereign onboarding — human name + passphrase — is the finishing step).

## All 3 inference models installed (offline) + per-model footprint

Offline-transferred from megaflax (manifest + blobs, no pull): `qwen2.5:3b` (classifier + responder), `moondream`
(vision/image-reader — was fail-closed to SEALED; now proven running), `nomic-embed-text` (recall embedder). 3.7 GB
on the flash. moondream + nomic-embed-text are the code defaults ⇒ no env change / no daemon restart. `OLLAMA_MAX_LOADED_MODELS=1`
⇒ one resident at a time (swap-on-demand). Responder = classifier (qwen2.5:3b) — the safe 8 GB pick.

Models live on the DATA DRIVE: `/media/flaxscrip/data/Aegis/ollama` (`/dev/sda1`, 6% used) bind-mounted to the
ollama container — NOT the SD.

**⚠️ tmpfs gotcha (found + fixed):** the Pi's `/tmp` is `tmpfs` (RAM). The transfer tarballs (~3.7 GB) sat there and
inflated every AI measurement by 1.8–3.7 GB. Deleting them freed ~3.2 GB of RAM (available 1.6 GB → 4.7 GB). CLEAN
numbers below.

| Resident model | mem used | available | swap |
|---|---|---|---|
| qwen2.5:3b (classifier/responder, 2.4 GB) | **3.5 GB** | **4.4 GB** | 250 MB |
| moondream (vision, 1.3 GB) | ~2.4 GB (est) | ~5.5 GB | low |

Any one model loads at a time (`OLLAMA_MAX_LOADED_MODELS=1`), evicting the previous. Vision is actually LIGHTER than
the classifier (smaller resident). 8 GB runs any single role with ~4+ GB free; co-loading two would OOM (hence =1).

## The classifier model — MEASURED (offline transfer)

`qwen2.5:3b` (1.9 GB) was **offline-transferred** from megaflax host ollama — extracted its manifest + 5 blobs,
tar'd (1.8 GB), scp'd to the Pi, unpacked into a containerized `ollama` on `aegis_internal` (aliased `ollama`,
`OLLAMA_MAX_LOADED_MODELS=1`). The sealed ollama registered it with **zero pull** (`ollama list` shows it). A single
CPU-only inference (~40 s to load+answer) made it resident. Loaded footprint: **model 2.4 GB resident** (100% CPU,
4096 ctx). This is why pi-lean pins `OLLAMA_MAX_LOADED_MODELS=1` — co-loading a 2nd (vision) model would be tight.

## AI family — Sovereign + agents (measured 2026-08-09)

The human Sovereign is the parent/governor; agents are provisioned under it with parent-SIGNED spend-allowance
rulesets (`deploy/node/family/provision-node-family.sh`). Each agent's runtime trinity = a Warden (control :4310,
self-provisions its own Warden id) + an AgentGate Signet (`sovereign agent-signet` — self-approves WITHIN the
allowance, no PIN; above-scope escalates to the parent's Signet). New parameterized compose:
`deploy/node/topology/docker-compose.pi-agent.yml` (pi-lean wired: gatekeeper:4224 + didcomm:4236).

| Configuration | used | available | containers |
|---|---|---|---|
| node core + Sovereign trinity | 1.1 GB | 6.8 GB | 12 |
| + 1 agent (aegis) | 1.4 GB | 6.5 GB | 15 |
| + 2 agents (aegis + sevenfold) | 1.6 GB | 6.3 GB | 18 |
| + 2 agents + classifier model | 3.8 GB | 4.1 GB | 18 |

**Each agent trinity ≈ 250 MB** (2 hearthold daemons + 1 bridge). 8 GB comfortably runs the Sovereign + several
agents; with 4.1 GB free after 2 agents + a model, RAM is not the near-term limit (model-swap/CPU is). AgentGate
self-approval means no per-agent human-consent overhead. Parent: `…kjkjn55hyua`; agents aegis `…fpqqs4q`,
sevenfold `…gcwzuwaq`, hearthold `…brnrgtfeq` — each its own partition (wallet/vault), all on the shared sealed
node + local registry.

## Verdict

**8 GB stands up — comfortably, even with the AI model.**
- ARM build peak: **1.7 GB**, 0 swap (no OOM — the risk that hit a prior node did not recur).
- Node + custodian (no AI): **1.3 GB** used, 6.7 GB free.
- **Full stack + qwen2.5:3b loaded: 5.2 GiB used, ~2.7 GiB available, only 85 MiB swap.**
The model is the dominant item (2.4 GB). Headroom is ~2.7 GB with one model loaded; that's the real ceiling to watch
if a vision model or heavier context is added. Swap-on-SD (off the flash) was barely touched.
