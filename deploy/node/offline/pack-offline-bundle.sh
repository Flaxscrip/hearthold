#!/usr/bin/env bash
#
# pack-offline-bundle.sh — build a fully self-contained, air-gap-ready bundle
# of the Aegis + Hearthold demo: every runtime Docker image + the two Ollama
# models + the compose overlays, so the whole stack boots on a machine with
# NO internet — not even at build/pull time.
#
# Run this on a machine that already has the stack built/pulled (i.e. the one
# where the demo currently runs). It only reads local Docker + ~/.ollama; it
# does not pull or build anything itself — if an image is missing it tells you
# to build/run the stack first rather than reaching for the network.
#
# Output: ./aegis-offline-bundle/ (gitignored) containing
#   images.tar.gz        all images from images.list, one docker save, gzipped
#   ollama-models.tar.gz  exactly qwen2.5:3b + nomic-embed-text (blobs+manifests)
#   compose/             the archon overlays + hearthold compose + run scripts
#   load-offline-bundle.sh  copied in, so the bundle is self-describing
#   MANIFEST.txt         sha256 of every artifact + the image digests packed
#
# Usage:
#   deploy/offline/pack-offline-bundle.sh [OUTDIR]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO_ROOT/deploy/offline"
OUT="${1:-$REPO_ROOT/aegis-offline-bundle}"
MODELS=("qwen2.5:3b" "nomic-embed-text:latest")
OLLAMA_STORE="${OLLAMA_MODELS_DIR:-$HOME/.ollama/models}"

log() { printf '\n\033[1m[pack] %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m[pack] ERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- read the image list (strip comments/blanks) ---
mapfile -t IMAGES < <(grep -vE '^\s*(#|$)' "$HERE/images.list")
[ "${#IMAGES[@]}" -gt 0 ] || die "images.list is empty"

# --- preflight: every image must already exist locally (no pull, no build) ---
log "Verifying ${#IMAGES[@]} images are present locally..."
missing=()
for img in "${IMAGES[@]}"; do
  docker image inspect "$img" >/dev/null 2>&1 || missing+=("$img")
done
if [ "${#missing[@]}" -gt 0 ]; then
  printf '  missing:\n'; printf '    %s\n' "${missing[@]}"
  die "build/pull the full stack first (bring the demo up), then re-run pack. This script never touches the network."
fi

# --- preflight: model blobs present ---
log "Verifying Ollama models are present in $OLLAMA_STORE..."
for m in "${MODELS[@]}"; do
  name="${m%%:*}"; tag="${m##*:}"
  [ -f "$OLLAMA_STORE/manifests/registry.ollama.ai/library/$name/$tag" ] \
    || die "model $m not found under $OLLAMA_STORE (pull it on this host first: ollama pull $m)"
done

mkdir -p "$OUT/compose"

# --- 1. docker save the whole image set (one archive -> shared layers dedupe) ---
log "docker save -> images.tar.gz  (this is the big one; a few minutes)..."
docker save "${IMAGES[@]}" | gzip > "$OUT/images.tar.gz"

# --- 2. package ONLY the two models' blobs + manifests, preserving layout ---
log "Packaging Ollama models (${MODELS[*]})..."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
python3 - "$OLLAMA_STORE" "$STAGE" "${MODELS[@]}" <<'PY'
import json, os, shutil, sys
store, stage = sys.argv[1], sys.argv[2]
models = sys.argv[3:]
blobs = set()
for m in models:
    name, tag = m.split(":")
    rel = f"manifests/registry.ollama.ai/library/{name}/{tag}"
    src = os.path.join(store, rel)
    dst = os.path.join(stage, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    with open(src) as f:
        man = json.load(f)
    blobs.add(man["config"]["digest"])
    for layer in man["layers"]:
        blobs.add(layer["digest"])
os.makedirs(os.path.join(stage, "blobs"), exist_ok=True)
for d in blobs:
    fn = "sha256-" + d.split(":")[1]
    shutil.copy2(os.path.join(store, "blobs", fn), os.path.join(stage, "blobs", fn))
print(f"  staged {len(blobs)} blobs for {len(models)} models")
PY
tar -C "$STAGE" -czf "$OUT/ollama-models.tar.gz" .

# --- 3. compose overlays + hearthold runtime files (small text, but needed
#        on a target that can't clone either repo) ---
log "Copying compose overlays + run scripts..."
# Archon side (this repo):
cp "$REPO_ROOT"/docker-compose.yml \
   "$REPO_ROOT"/docker-compose.override.yml \
   "$REPO_ROOT"/docker-compose.lightning-regtest.yml \
   "$REPO_ROOT"/docker-compose.lightning-zap.yml \
   "$REPO_ROOT"/docker-compose.ollama.yml \
   "$REPO_ROOT"/sample.env \
   "$OUT/compose/"
cp -r "$REPO_ROOT"/docker/compose "$OUT/compose/archon-compose-fragments"
cp -r "$REPO_ROOT"/scripts/sandbox "$OUT/compose/archon-scripts-sandbox"
# Hearthold side (sibling repo), if present — its prebuilt image is already in
# images.tar.gz; these are just the compose + run scripts needed to drive it.
HH="${HEARTHOLD_DIR:-$HOME/hearthold}"
if [ -f "$HH/docker-compose.hearthold.yml" ]; then
  mkdir -p "$OUT/compose/hearthold"
  cp "$HH/docker-compose.hearthold.yml" "$OUT/compose/hearthold/"
  [ -f "$HH/.env.example" ] && cp "$HH/.env.example" "$OUT/compose/hearthold/"
  [ -d "$HH/deploy/sandbox" ] && cp -r "$HH/deploy/sandbox" "$OUT/compose/hearthold/deploy-sandbox"
  echo "  included Hearthold compose + scripts from $HH"
else
  echo "  (Hearthold repo not found at $HH — its image is bundled; copy its compose/scripts manually)"
fi

# --- 4. self-describing: drop the loader + this list in ---
cp "$HERE/load-offline-bundle.sh" "$OUT/"
cp "$HERE/images.list" "$OUT/"
chmod +x "$OUT/load-offline-bundle.sh"

# --- 5. manifest with checksums + packed image digests ---
log "Writing MANIFEST.txt (checksums + image digests)..."
{
  echo "Aegis offline bundle"
  echo "packed-from-host: $(uname -srm)"
  echo "images (from images.list):"
  for img in "${IMAGES[@]}"; do
    digest="$(docker image inspect "$img" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo '<local-build>')"
    echo "  $img    $digest"
  done
  echo "models: ${MODELS[*]}"
  echo "artifact sha256:"
  for f in images.tar.gz ollama-models.tar.gz; do
    echo "  $(cd "$OUT" && shasum -a 256 "$f")"
  done
} > "$OUT/MANIFEST.txt"

log "Done. Bundle at: $OUT"
du -sh "$OUT"/* 2>/dev/null || true
echo
echo "Ship the whole $OUT/ directory to the air-gapped target, then run:"
echo "  ./load-offline-bundle.sh"
