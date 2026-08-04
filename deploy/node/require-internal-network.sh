#!/usr/bin/env bash
# Preflight guard — refuse to proceed unless the target Docker network exists AND is internal:true.
#
# The single invariant every Aegis/Hearthold bring-up shares: services only ever join a SEALED
# (internal:true, zero-egress) network. This is the fail-loud check that stops a stack from ever
# silently landing on an egress-capable network (e.g. a generic `archon_default` a stock Archon
# compose would create). Call it before any `docker compose up` / `docker run --network …`.
#
#   deploy/require-internal-network.sh aegis_internal
set -euo pipefail
NET="${1:?usage: require-internal-network.sh <network>}"

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  echo "ERROR: docker network '$NET' does not exist." >&2
  echo "       Create the sealed node network first:  ./deploy/create-internal-network.sh $NET" >&2
  exit 1
fi

INTERNAL=$(docker network inspect "$NET" --format '{{.Internal}}' 2>/dev/null)
if [ "$INTERNAL" != "true" ]; then
  echo "REFUSING: network '$NET' is internal=$INTERNAL (egress-capable)." >&2
  echo "  Aegis/Hearthold services must ONLY join an ISOLATED (internal:true) network — a non-sealed net" >&2
  echo "  could reach the internet or be shared with a stock deployment. Point at an internal network, or" >&2
  echo "  recreate '$NET' with:  docker network create --driver bridge --internal --subnet 10.83.0.0/24 $NET" >&2
  exit 1
fi

echo "network '$NET' is internal:true ✓ (zero egress)"
