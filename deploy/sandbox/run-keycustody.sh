#!/usr/bin/env bash
#
# Key-custody policy in the sandbox — the SOVEREIGN decides which R-DIDs it keys itself.
#
# The Sovereign signs a key-custody policy (its own choice, per audience — never a category): which
# relationships it keys in its Signet (subject-keyed, proves control directly) vs. lets the Warden hold
# (Warden-keyed, presents on its behalf). The Warden ENFORCES it — refused from keying a relationship the
# Sovereign chose to control — and the Sovereign can change its mind by signing a new version.
#
#   ./deploy/sandbox/run-keycustody.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
CF=docker-compose.hearthold.yml
printf '\n\033[1;36m━━ finance-keycustody — the Sovereign decides which R-DIDs it keys itself ━━\033[0m\n'
printf '   \033[2mSigned, per-relationship key custody (Signet vs Warden); Warden-enforced; Sovereign can revise.\033[0m\n'
docker compose -f "$CF" exec -T \
  -e HEARTHOLD_DATA_ROOT=/data/flow-finance-keycustody \
  -e HEARTHOLD_CLASSIFIER=quarantine -e HEARTHOLD_INDEX=off \
  -e HEARTHOLD_PASSPHRASE=flow-finance-keycustody \
  warden node --experimental-strip-types scripts/e2e-finance-keycustody.ts 2>&1 | grep -vE 'ExperimentalWarning|trace-warning'
printf '\n\033[32m✓ key-custody policy verified in the isolated sandbox\033[0m\n'
