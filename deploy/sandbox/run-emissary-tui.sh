#!/usr/bin/env bash
#
# Emissary TUI — the terminal front-end for submitting observations, for contained demos with no web UI.
# Brings up the full submit path (Warden serving + delegated, Emissary control daemon) and runs the Ink
# TUI. Architecturally option (a): the TUI is a client of the Emissary's localhost control API
# (127.0.0.1:4312, never exposed to the host); one-command UX.
#
#   ./deploy/sandbox/run-emissary-tui.sh
#
# In the TUI: 's' → pick a kind → type the observation → Enter. The receipt appears; once the Warden
# stores + classifies it (Ollama), the row updates with its sensitivity.
set -euo pipefail

cd "$(dirname "$0")/../.."
CF=docker-compose.hearthold.yml
w()  { docker compose -f "$CF" exec -T warden   node packages/warden/dist/index.js "$@"; }
e()  { docker compose -f "$CF" exec -T emissary node packages/emissary/dist/index.js "$@"; }
did() { grep -oE 'did:cid:[a-z0-9]+' | head -1; }

echo "Provisioning the submit path (Warden serving + delegated → Emissary)…"
WARDEN_DID=$(w init | did)
EMISSARY_DID=$(e init | did)
w delegate "$EMISSARY_DID" >/dev/null            # authorize the Emissary's submissions (idempotent)

# Warden serves (drains the mailbox + classifies) — detached, once.
if ! docker compose -f "$CF" exec -T warden pgrep -f 'warden/dist/index.js serve' >/dev/null 2>&1; then
  docker compose -f "$CF" exec -dT warden node packages/warden/dist/index.js serve >/dev/null 2>&1 || true
fi

# Emissary control daemon (needs the Warden DID to address submissions) — detached, once.
if ! docker compose -f "$CF" exec -T emissary node -e "fetch('http://127.0.0.1:4312/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "Starting the Emissary control daemon (warden ${WARDEN_DID:0:20}…)…"
  docker compose -f "$CF" exec -dT -e HEARTHOLD_WARDEN_DID="$WARDEN_DID" emissary \
    node packages/emissary/dist/index.js control >/dev/null 2>&1 || true
  for i in $(seq 1 15); do
    docker compose -f "$CF" exec -T emissary node -e "fetch('http://127.0.0.1:4312/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break
    sleep 1
  done
fi

echo "Emissary TUI — ‘s’ submit · ‘q’ quit"
exec docker compose -f "$CF" exec -it -e HEARTHOLD_CONTROL_URL=http://127.0.0.1:4312 emissary \
  node packages/emissary-tui/dist/index.js
