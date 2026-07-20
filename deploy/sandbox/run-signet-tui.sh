#!/usr/bin/env bash
#
# Signet TUI — the terminal front-end for approving disclosures, for contained demos with no web UI.
# Starts the Sovereign control daemon (background, in the sovereign container) and runs the Ink TUI
# (foreground). One command; architecturally option (a) — the TUI is a client of the localhost control
# API (127.0.0.1:4311, never exposed to the host) — with (b)-simple one-command UX.
#
#   ./deploy/sandbox/run-signet-tui.sh [pin]      # default PIN 1379
#
# Then, from another terminal, trigger a disclosure — e.g. the prove flow:
#   ./deploy/sandbox/run-prove.sh verify          # a proof-request appears in the TUI → a/d to decide
set -euo pipefail

cd "$(dirname "$0")/../.."
CF=docker-compose.hearthold.yml
PIN="${1:-1379}"
sov() { docker compose -f "$CF" exec -T "$@"; }

# Ensure the Sovereign identity exists.
sov sovereign node packages/sovereign/dist/index.js init >/dev/null

# Start the control daemon once (HttpGate compares the PIN set here). If :4311 is already serving, reuse it.
if ! sov sovereign node -e "fetch('http://127.0.0.1:4311/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "Starting the Sovereign control daemon (PIN $PIN)…"
  docker compose -f "$CF" exec -dT -e HEARTHOLD_SIGNET_PIN="$PIN" sovereign \
    node packages/sovereign/dist/index.js control >/dev/null 2>&1 || true
  for i in $(seq 1 15); do
    sov sovereign node -e "fetch('http://127.0.0.1:4311/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break
    sleep 1
  done
fi

echo "Signet TUI — ↑/↓ select · a approve · d deny · q quit  (trigger a disclosure from another terminal)"
exec docker compose -f "$CF" exec -it -e HEARTHOLD_CONTROL_URL=http://127.0.0.1:4311 sovereign \
  node packages/signet-tui/dist/index.js
