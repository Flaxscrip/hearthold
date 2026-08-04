# Aegis offline bundle — boot the whole demo with the cord cut

Everything else in this repo proves the stack is isolated **at runtime** — no
container can reach the internet once it's up (SANDBOX-PROFILE.md §3). But the
images are still *built* and *pulled* with internet. This directory closes that
last gap: it packages every runtime artifact so the complete Aegis + Hearthold
demo boots on a machine that has **no internet at all, ever** — the true
air-gapped-hackathon case.

## The two-machine model

```
  ┌─ prep machine (online) ────────┐        ┌─ target (air-gapped) ──────────┐
  │  stack already built & pulled  │  ship  │  docker load + unpack, then    │
  │  pack-offline-bundle.sh   ─────┼──────► │  load-offline-bundle.sh        │
  │  → aegis-offline-bundle/       │  (usb, │  → docker compose up --no-build│
  └────────────────────────────────┘  scp) └────────────────────────────────┘
```

The prep machine is the one where the demo already runs (all images in the
local Docker cache, both models pulled into `~/.ollama`). The target never
touches a registry, an npm server, or `ollama pull`.

## Pack (on the online/prep machine)

```bash
deploy/offline/pack-offline-bundle.sh
```

Produces `aegis-offline-bundle/` (gitignored — it's multiple GB):

| File | What |
|------|------|
| `images.tar.gz` | One `docker save` of every image in `images.list`, gzipped. Shared layers across the six `archetech/*` Node images + Hearthold dedupe, so it's far smaller than the raw per-image sum. |
| `ollama-models.tar.gz` | Exactly `qwen2.5:3b` + `nomic-embed-text` — their 9 content-addressed blobs + manifests, in Ollama's on-disk layout (~2.2 GB). Not your whole `~/.ollama`. |
| `compose/` | The archon overlays, the compose fragments, `scripts/sandbox/`, and (if present) Hearthold's compose + `deploy/sandbox` scripts. Text the target can't clone. |
| `load-offline-bundle.sh`, `images.list`, `MANIFEST.txt` | The loader, the canonical image set, and sha256s + packed image digests. |

pack **never uses the network** — it only reads the local Docker daemon and
`~/.ollama`. If an image or model is missing it stops and tells you to build /
pull it first, rather than reaching out.

## Load (on the air-gapped target)

Ship the whole `aegis-offline-bundle/` dir over (USB, scp on a local link, …),
unpack, then:

```bash
cd aegis-offline-bundle
./load-offline-bundle.sh --verify      # docker load images + unpack models
```

Then bring the stack up **without `--build`** — the images are already loaded;
a `--build` (or an `up` on a service whose image is missing) is the one thing
that would reach for npm/a registry and fail off-network:

```bash
export AEGIS_OLLAMA_MODELS="$PWD/ollama-models"   # the unpacked model dir
cd /path/to/archon-checkout        # or the bundle's compose/ dir
cp sample.env .env                 # then set the values per SANDBOX-PROFILE.md §2
docker compose --env-file .env up -d --no-build
docker compose -f docker-compose.ollama.yml up -d
# + the lightning-zap / didcomm add-ons per SANDBOX-PROFILE.md §9/§11
```

## Prove the air gap actually held

The whole point — after bring-up, on the target:

```bash
docker exec aegis-gatekeeper-1 \
  node -e 'require("http").get({host:"1.1.1.1",port:80,timeout:5000},()=>{}).on("error",e=>console.log("egress:",e.code))'
# → egress: ENETUNREACH
```

Same `ENETUNREACH` proof as SANDBOX-PROFILE.md §3, now on a box that was never
online. If you want the strongest demonstration, physically disconnect the
target (or run it on a host-only VM network) before `load` — nothing here needs
the network, so it all still comes up.

## Keeping `images.list` honest

`images.list` is the single source of truth for what's in the bundle; pack and
load both read it. If you add or version-bump a service, update that file. To
regenerate the "what's actually running" set as a cross-check:

```bash
docker ps -a --format '{{.Image}}' | sort -u
```
