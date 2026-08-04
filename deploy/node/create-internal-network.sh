#!/usr/bin/env bash
# Create the Aegis node's SEALED, uniquely-named internal network. Run ONCE before bringing the node up.
#
# The name is deliberately NOT `archon_default`: that is the network a stock Archon deployment (compose
# project "archon") creates/adopts, so sharing the name would let a standard same-host deployment land on
# our isolated net by name alone. `aegis_internal` cannot be resolved to by any stock deployment.
#   --internal        no default route / NAT out of the bridge  → zero public egress
#   --subnet 10.83.*  a pinned, non-Docker-default subnet (avoids the auto-assigned 172.x range)
set -euo pipefail
NAME="${1:-aegis_internal}"
SUBNET="${2:-10.83.0.0/24}"
if docker network inspect "$NAME" >/dev/null 2>&1; then
  echo "network $NAME already exists: internal=$(docker network inspect "$NAME" -f '{{.Internal}}') subnet=$(docker network inspect "$NAME" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
else
  docker network create --driver bridge --internal --subnet "$SUBNET" "$NAME"
  echo "created $NAME (internal, $SUBNET)"
fi
