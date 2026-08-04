#!/usr/bin/env bash
# Relaunch the gamerflax sphere node (sphere-gamer) — the tailnet peer/fallback for megaflax.
#
# One command, run ON gamerflax from anywhere in the repo:
#   deploy/topology/start-gamerflax.sh          # up (default)
#   deploy/topology/start-gamerflax.sh down     # stop + remove (keeps volumes/DIDs)
#   deploy/topology/start-gamerflax.sh status    # what's running + health
#
# It reads deploy/topology/gamerflax.env for the ONE thing you can't hardcode — the shared sphere
# topic (ARCHON_PROTOCOL) — then assembles the exact overlay stack from CONTAINER-TOPOLOGY.md §5:
#   measure.yml (full node) + sphere-tailnet.yml (peer fallback) + sealed.yml (guard publishes :4324,
#   never the raw gatekeeper) + emulate-arm64.yml.
set -euo pipefail

# --- locate the repo + files regardless of cwd ---------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"          # deploy/topology
ROOT="$(cd "$HERE/../.." && pwd)"                              # repo root
ENV_FILE="$HERE/gamerflax.env"
cd "$ROOT"

cmd="${1:-up}"
case "$cmd" in up|down|status) : ;; *) echo "usage: start-gamerflax.sh [up|down|status]" >&2; exit 2 ;; esac

# --- load config ---------------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Seed it from either example, then paste the shared sphere topic:" >&2
  echo "  cp $HERE/gamerflax.env.example $ENV_FILE   # preferred (documents every knob)" >&2
  echo "  cp $HERE/sphere.env.example    $ENV_FILE   # also fine — only ARCHON_PROTOCOL is required" >&2
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

# ARCHON_PROTOCOL is the only value the env file MUST supply (the shared sphere topic). The rest have
# sane defaults for this pair, so a filled sphere.env works as the env file too — see --help.
: "${ARCHON_PROTOCOL:?set ARCHON_PROTOCOL in $ENV_FILE (the shared sphere topic — must match megaflax)}"
PEER_GATEKEEPER_URL="${PEER_GATEKEEPER_URL:-http://100.81.183.80:4324}"   # megaflax tailnet gatekeeper
PROJECT="${PROJECT:-sphere-gamer}"
EMULATE="${EMULATE:-1}"

case "$ARCHON_PROTOCOL" in
  *REPLACE_WITH_SHARED_HEX*|*'<'*) echo "ERROR: ARCHON_PROTOCOL still has a placeholder — paste the real shared hex from megaflax into $ENV_FILE." >&2; exit 1;;
esac

# --- assemble the compose file stack -------------------------------------------------------------
# sealed.yml is ALWAYS included: the tailnet :4324 is published only through the resolution-only guard,
# never the raw gatekeeper (Hearthold ask #3 — seal by construction, not a remembered overlay).
FILES=(-f deploy/topology/docker-compose.measure.yml
       -f deploy/topology/docker-compose.sphere-tailnet.yml
       -f deploy/topology/docker-compose.sealed.yml)
if [[ "$EMULATE" == "1" ]]; then
  FILES+=(-f deploy/topology/docker-compose.emulate-arm64.yml)
fi

compose() { docker compose -p "$PROJECT" "${FILES[@]}" "$@"; }

# --- subcommands ---------------------------------------------------------------------------------
case "$cmd" in
  down)
    echo "Stopping $PROJECT (volumes/DIDs kept — use 'down -v' by hand to wipe)…"
    compose down
    exit 0
    ;;
  status)
    compose ps
    echo "--- gatekeeper ready? ---"
    curl -fsS "http://127.0.0.1:4324/api/v1/ready" && echo || echo "(not ready)"
    exit 0
    ;;
  up) : ;;  # fall through
  *) echo "usage: start-gamerflax.sh [up|down|status]" >&2; exit 2 ;;
esac

# --- emulation vs native --------------------------------------------------------------------------
if [[ "$EMULATE" == "1" ]]; then
  # ensure qemu arm64 emulation is registered (idempotent)
  if ! docker run --rm --platform linux/arm64 alpine:3.20 true >/dev/null 2>&1; then
    echo "Registering qemu arm64 emulation (one-time)…"
    docker run --privileged --rm tonistiigi/binfmt --install arm64
  fi
else
  # NATIVE mode — no qemu. Guard: warn if the archon images are still arm64 (they'd fail to run direct).
  HOST_ARCH=$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo '?')
  for i in gatekeeper-typescript keymaster hyperswarm-mediator; do
    a=$(docker image inspect "ghcr.io/archetech/$i:latest" --format '{{.Architecture}}' 2>/dev/null || echo missing)
    if [ "$a" != "$HOST_ARCH" ]; then
      echo "WARNING: ghcr.io/archetech/$i is '$a', not native '$HOST_ARCH' — run deploy/topology/build-native.sh" >&2
      echo "         first, or set EMULATE=1. Continuing, but this image may fail without emulation." >&2
    fi
  done
fi

# --- bring it up ---------------------------------------------------------------------------------
echo "Launching $PROJECT"
echo "  topic:  $ARCHON_PROTOCOL"
echo "  peer:   $PEER_GATEKEEPER_URL"
echo "  emulate arm64: $EMULATE"
compose up -d

# --- wait for the gatekeeper, then report --------------------------------------------------------
echo -n "Waiting for gatekeeper on :4324 "
for _ in $(seq 1 60); do
  if [[ "$(curl -fsS http://127.0.0.1:4324/api/v1/ready 2>/dev/null || true)" == "true" ]]; then
    echo "— ready ✓"
    MY_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
    echo
    echo "sphere-gamer is up."
    [[ -n "$MY_IP" ]] && echo "  this node's tailnet gatekeeper: http://$MY_IP:4324   (megaflax fallback → this)"
    echo -n "  peer reachable ($PEER_GATEKEEPER_URL): "
    curl -fsS "$PEER_GATEKEEPER_URL/api/v1/ready" >/dev/null 2>&1 && echo "yes ✓" || echo "no (is megaflax up?)"
    exit 0
  fi
  echo -n "."; sleep 2
done
echo
echo "Gatekeeper did not report ready in time. Check: deploy/topology/start-gamerflax.sh status" >&2
exit 1
