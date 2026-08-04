#!/usr/bin/env bash
#
# load-offline-bundle.sh — restore the Aegis + Hearthold demo on an AIR-GAPPED
# target from a bundle built by pack-offline-bundle.sh. Touches the network
# zero times: it only `docker load`s images and unpacks model files.
#
# Run it from inside the unpacked bundle directory (it sits next to
# images.tar.gz / ollama-models.tar.gz).
#
# Usage:
#   ./load-offline-bundle.sh            # load images + unpack models
#   ./load-offline-bundle.sh --verify   # also assert every images.list entry loaded
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MODELS_OUT="$HERE/ollama-models"

log() { printf '\n\033[1m[load] %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m[load] ERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$HERE/images.tar.gz" ]        || die "images.tar.gz not found — run this from inside the unpacked bundle"
[ -f "$HERE/ollama-models.tar.gz" ] || die "ollama-models.tar.gz not found"

# --- 1. load every image (docker load restores original name:tag) ---
log "docker load <- images.tar.gz  (a few minutes)..."
gunzip -c "$HERE/images.tar.gz" | docker load

# --- 2. unpack the two models into ./ollama-models (the read-only mount source) ---
log "Unpacking Ollama models -> $MODELS_OUT ..."
mkdir -p "$MODELS_OUT"
tar -C "$MODELS_OUT" -xzf "$HERE/ollama-models.tar.gz"

# --- 3. verify (optional) ---
if [ "${1:-}" = "--verify" ]; then
  log "Verifying all images.list entries are present..."
  miss=0
  while IFS= read -r img; do
    [ -z "$img" ] && continue
    if docker image inspect "$img" >/dev/null 2>&1; then
      echo "  ok  $img"
    else
      echo "  MISSING  $img"; miss=1
    fi
  done < <(grep -vE '^\s*(#|$)' "$HERE/images.list")
  [ "$miss" -eq 0 ] || die "some images did not load"
fi

cat <<EOF

[load] Done. Images loaded, models at:
  $MODELS_OUT

Next — bring the stack up WITHOUT --build (images are already loaded; --build
or a plain 'up' on a service whose image is missing would try to build/pull
and fail off-network). Point Ollama at the unpacked models via AEGIS_OLLAMA_MODELS:

  cd <archon checkout or bundle compose/ dir>
  export AEGIS_OLLAMA_MODELS="$MODELS_OUT"

  # core node (override.yml auto-loads the internal:true network):
  docker compose --env-file .env up -d --no-build

  # ollama + lightning + didcomm add-ons (see SANDBOX-PROFILE.md §8/§9/§11):
  docker compose -f docker-compose.ollama.yml up -d
  # ...plus the lightning-zap / didcomm services as documented.

Then prove the air gap held:
  docker exec aegis-gatekeeper-1 node -e 'require("http").get({host:"1.1.1.1",port:80,timeout:5000},()=>{}).on("error",e=>console.log(e.code))'
  # -> ENETUNREACH
EOF
