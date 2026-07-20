#!/usr/bin/env bash
#
# Contained demo — the full Hearthold walkthrough on the offline, egress-isolated Archon sandbox, with
# NO web UI exposed to the host. Runs the automated proofs + provisioning, then hands off to the two
# interactive terminal UIs (the Signet and Emissary TUIs), each in its own terminal.
#
#   ./deploy/sandbox/run-demo.sh          # preflight → isolation proof → provision → TUI handoff
#   ./deploy/sandbox/run-demo.sh reset    # tear down + wipe ./data for a clean re-run
#
# The two TUIs are interactive (an Ink app needs its own TTY), so they aren't launched from here — this
# script gets everything ready and prints the exact commands to run in separate terminals. The slow 8B
# classification is deliberately kept off this path so the walkthrough stays fast.
set -euo pipefail

cd "$(dirname "$0")/../.."
CF=docker-compose.hearthold.yml
D=./deploy/sandbox
sec() { printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$*"; }
ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }

case "${1:-run}" in
  reset)
    docker compose -f "$CF" down 2>&1 | tail -1 || true
    rm -rf ./data && mkdir -p ./data
    ok "torn down + ./data wiped — the next run starts from clean identities"
    exit 0
    ;;
  run) : ;;
  *) echo "usage: $0 [run|reset]"; exit 2 ;;
esac

sec "0 · Preflight — the isolated stack"
docker compose -f "$CF" up -d >/dev/null
INTERNAL=$(docker network inspect archon_default --format '{{.Internal}}' 2>/dev/null || echo '?')
ok "archon_default internal=$INTERNAL  (no container on it can reach the internet)"
docker compose -f "$CF" exec -T warden node -e "
  fetch('http://drawbridge:4222/api/v1/capabilities').then(r=>r.json())
    .then(j=>{ console.log('   [32m✓[0m node reachable in-network — capabilities '+JSON.stringify(j)); })
    .catch(()=>{ console.log('   [31m✗[0m node UNREACHABLE at http://drawbridge:4222 — is the Archon sandbox up?'); process.exit(1); })"

sec "1 · Egress isolation (the load-bearing property)"
"$D/run-spine.sh" --egress-only

sec "2 · Provision the prove flow (issuer + GuildMembership credential + verifier)"
"$D/run-prove.sh" setup

sec "3 · Interactive TUIs — run each in its OWN terminal (nothing is published to the host)"
cat <<EOF

  🔑  Signet approvals TUI — the Sovereign's proof-of-human gate
        $D/run-signet-tui.sh 1379
      then, in a THIRD terminal, trigger a disclosure:
        $D/run-prove.sh verify
      → a proof-request appears in the TUI · press 'a' + PIN 1379 to approve · verifier prints ✓ VERIFIED

  📡  Emissary submit TUI — observe → seal → submit to the Warden
        $D/run-emissary-tui.sh
      → press 's' · pick a kind · type an observation · Enter → the receipt appears immediately;
        its sensitivity fills in once the Warden classifies it on-device.

  Tear down:      docker compose -f $CF down
  Clean re-run:   $D/run-demo.sh reset

  NB: on-device classification currently runs qwen3:8b (slow — 2+ min/artefact). A lighter model is
  being evaluated (Aegis). The Emissary TUI shows the receipt instantly regardless; the sensitivity
  updates when the Warden finishes.
EOF
ok "walkthrough ready — open the terminals above"
