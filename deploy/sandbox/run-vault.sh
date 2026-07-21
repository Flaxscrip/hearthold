#!/usr/bin/env bash
#
# VC → KB bridge in the sandbox — a 3rd-party credential becomes private-from-the-Warden knowledge.
#
# A bank issues an AccreditedInvestor credential to the Sovereign, who accepts it; the Warden then
# write-hosts it into the Sovereign's PRIVATE member-key KB partition. The fact is sealed to the
# partition's public key — the Warden custodies + write-hosts it but CANNOT read it at rest; only the
# Sovereign's (session-rewrapped) partition key reads it back. The artefact stays linked to the signed
# credential, so trust remains with the ISSUER (still presentable / composable as an `issued` leaf).
#
# The second half of the 3rd-party-VC story (run-onboarding.sh is the first: the Sovereign proves control
# of the R-DID the VC is issued to). Runs in-container against the isolated node, isolated data root.
#
#   ./deploy/sandbox/run-vault.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
CF=docker-compose.hearthold.yml

printf '\n\033[1;36m━━ finance-vault — 3rd-party VC → private member-key KB partition ━━\033[0m\n'
printf '   \033[2mBank VC ingested private-from-the-Warden: sealed to the partition key, recallable by the Sovereign, still issuer-provable.\033[0m\n'
docker compose -f "$CF" exec -T \
  -e HEARTHOLD_DATA_ROOT=/data/flow-finance-vault \
  -e HEARTHOLD_CLASSIFIER=quarantine -e HEARTHOLD_INDEX=off \
  -e HEARTHOLD_PASSPHRASE=flow-finance-vault \
  warden node --experimental-strip-types scripts/e2e-finance-vault.ts 2>&1 | grep -vE 'ExperimentalWarning|trace-warning'

printf '\n\033[32m✓ VC → KB bridge verified in the isolated sandbox\033[0m\n'
