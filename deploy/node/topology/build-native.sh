#!/usr/bin/env bash
# Build the arm64-only archetech images NATIVELY from source, so a node runs at full host speed instead of
# emulating arm64 via qemu. The aegis repo IS the Archon source (docker/Dockerfile.* + services/), so any
# host can build for its own native arch — no dependency on macterra publishing multi-arch images.
#
# Run ON the target host (builds for its native arch). It overwrites the ghcr tags with local native builds;
# then bring the node up WITHOUT the emulate-arm64 overlay (set EMULATE=0 in gamerflax.env).
#
#   deploy/topology/build-native.sh
#
# Only the images that ship arm64-only need this — our own sidecars (aegis-secure-mediator, guards, bridges)
# are already multi-arch (node:22-slim / alpine).
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root = the build context

build(){ printf '\n── building %s  (%s) ──\n' "$2" "$1"; docker build -f "$1" -t "$2" . ; }

build docker/Dockerfile.gatekeeper-ts ghcr.io/archetech/gatekeeper-typescript:latest
build docker/Dockerfile.keymaster-ts  ghcr.io/archetech/keymaster:latest
build docker/Dockerfile.hyperswarm    ghcr.io/archetech/hyperswarm-mediator:latest

echo
echo "── resulting arch (want the host's native arch — e.g. amd64 on an x86-64 box, NOT arm64): ──"
host_arch=$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo '?')
for i in gatekeeper-typescript keymaster hyperswarm-mediator; do
  a=$(docker image inspect "ghcr.io/archetech/$i:latest" --format '{{.Architecture}}' 2>/dev/null || echo missing)
  mark=$([ "$a" = "$host_arch" ] && echo "✓ native" || echo "⚠ not native")
  printf "  %-22s %-6s %s\n" "$i" "$a" "$mark"
done
echo
echo "Next: set EMULATE=0 in deploy/topology/gamerflax.env, then run deploy/topology/start-gamerflax.sh"
echo "(EMULATE=0 skips the qemu binfmt step + the emulate-arm64 overlay, so these native images run direct.)"
