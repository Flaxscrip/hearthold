#!/usr/bin/env bash
# provision-node-family.sh — stand up the node family (Aegis · Sevenfold · Hearthold) FRESH under the
# real node Sovereign (…ij3ufa / flaxscrip / the Table login), in the `node` environment's identity store.
#
# Reproducible + idempotent: re-run any time to recreate the environment. No migration of old test data.
# The live node Sovereign data is mounted READ-ONLY; the parent key only signs (never mutated).
#
#   ./deploy/family/provision-node-family.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

NET="${AEGIS_NET:-aegis_internal}"                                   # sealed node network
IMAGE="${AEGIS_KM_IMAGE:-hearthold:sandbox}"                         # image with @hearthold/core
PARENT_DATA="${AEGIS_SOVEREIGN_DATA:-$HOME/aegis-sovereign-hs/data}" # node Sovereign …ij3ufa lives here
NODE_ENV_DATA="${AEGIS_NODE_ENV_DATA:-$HOME/aegis-env/node/data}"    # fresh agents land here
CONTROL_ENV="${AEGIS_CONTROL_ENV:-$HOME/.control-mega.env}"          # source of the Sovereign passphrase
FAMENV="${AEGIS_FAMILY_ENV:-$HERE/family.env}"                       # source of the agent passphrase

# Guard: only ever operate on the SEALED (internal:true) network — never an egress-capable one.
[ "$(docker network inspect "$NET" --format '{{.Internal}}' 2>/dev/null)" = true ] || {
  echo "provision: REFUSING — network '$NET' is not internal:true" >&2; exit 1; }
[ -f "$CONTROL_ENV" ] || { echo "provision: no control env at $CONTROL_ENV (Sovereign passphrase)" >&2; exit 1; }
[ -f "$FAMENV" ]      || { echo "provision: no family env at $FAMENV (agent passphrase)" >&2; exit 1; }

mkdir -p "$NODE_ENV_DATA/identities/agents"

# Secrets go into a shredded temp env-file — never the command line, never a shell var.
tmpenv=$(mktemp); trap 'shred -u "$tmpenv" 2>/dev/null || rm -f "$tmpenv"' EXIT
{
  echo "HEARTHOLD_NODE_URL=http://gatekeeper:4224"
  echo "HEARTHOLD_REGISTRY=local"
  echo "HEARTHOLD_DATA_ROOT=/node-data"
  echo "PARENT_DATA_ROOT=/parent-data"
  echo "AGENTS_DATA_ROOT=/node-data/identities/agents"
  grep -E '^HEARTHOLD_PASSPHRASE=' "$CONTROL_ENV" | sed 's/^HEARTHOLD_PASSPHRASE=/PARENT_PASSPHRASE=/'
  grep -E '^FAMILY_PASSPHRASE='    "$FAMENV"      | sed 's/^FAMILY_PASSPHRASE=/AGENT_PASSPHRASE=/'
} > "$tmpenv"

exec docker run --rm --network "$NET" --env-file "$tmpenv" \
  -v "$PARENT_DATA:/parent-data:ro" \
  -v "$NODE_ENV_DATA:/node-data" \
  -v "$HERE/provision-node-family.ts:/app/provision-node-family.ts:ro" \
  -w /app --entrypoint node "$IMAGE" \
  --experimental-strip-types /app/provision-node-family.ts
