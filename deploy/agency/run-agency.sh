#!/bin/sh
# Launch wrapper for the private "agency" KB (David's corpus) on megaflax.
#
# LaunchAgent plists run this; it sources the role's 0600 env file (which holds HEARTHOLD_PASSPHRASE +
# the data root + HEARTHOLD_ANSWER_MODEL=qwen3:8b, etc.) so no secret lives in the plist, then execs node.
# Bound to 127.0.0.1 by default (the Mage's kb-web loopback bind) — nothing faces the network until/unless
# an endpoint is deliberately chosen at handoff.
#
# Usage (from the plist ProgramArguments):  run-agency.sh <envfile> warden|kb-mage
set -eu

ENVFILE="${1:?usage: run-agency.sh <envfile> warden|kb-mage}"
ROLE="${2:?usage: run-agency.sh <envfile> warden|kb-mage}"

# shellcheck disable=SC1090
set -a; . "$ENVFILE"; set +a

NODE="${HEARTHOLD_NODE:-$(command -v node)}"
APP="${HEARTHOLD_APP:-/opt/hearthold}"   # megaflax repo path — set HEARTHOLD_APP in the env file if different

case "$ROLE" in
  warden)  exec "$NODE" "$APP/packages/warden/dist/index.js" serve ;;
  kb-mage) exec "$NODE" "$APP/packages/emissary/dist/index.js" kb-web "${HEARTHOLD_KB_WEB_PORT:-4313}" ;;
  *) echo "run-agency.sh: unknown role '$ROLE' (warden|kb-mage)" >&2; exit 2 ;;
esac
