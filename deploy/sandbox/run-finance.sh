#!/usr/bin/env bash
#
# Financial evidence-graph flow in the sandbox — the "prove a compliance fact without disclosing the
# figures" story, themed for a finance/auditor audience. Financial variants of run-evidence.sh:
#
#   finance-evidence   attest a DERIVED threshold fact ("annual income exceeds the $200,000
#                      accredited-investor threshold") from quarterly income records — the verifier
#                      learns the fact + that records back it (count, Merkle root), never the amounts.
#   finance-selective  an auditor spot-checks ONE quarter's record against the signed root; the rest stay hidden.
#   finance-stepup     MEDIUM-sensitivity income records → the Sovereign's Signet co-sign, embedded +
#                      independently verifiable (no decryption).
#
# Each runs in its own throwaway data root (quarantine classifier, no index), so it never touches the
# demo agents' identities and is deterministic. Run:  ./deploy/sandbox/run-finance.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
CF=docker-compose.hearthold.yml

flow() {
  local name="$1" desc="$2"
  printf '\n\033[1;36m━━ %s ━━\033[0m\n   \033[2m%s\033[0m\n' "$name" "$desc"
  docker compose -f "$CF" exec -T \
    -e HEARTHOLD_DATA_ROOT="/data/flow-$name" \
    -e HEARTHOLD_CLASSIFIER=quarantine -e HEARTHOLD_INDEX=off \
    -e HEARTHOLD_PASSPHRASE="flow-$name" \
    warden node --experimental-strip-types "scripts/e2e-$name.ts" 2>&1 | grep -vE 'ExperimentalWarning|trace-warning'
}

flow finance-evidence  "attest 'annual income exceeds the \$200,000 threshold' from quarterly records — figures never disclosed"
flow finance-selective "auditor spot-checks ONE quarter against the signed Merkle root; the rest stay hidden"
flow finance-stepup    "MEDIUM-sensitivity income → the Sovereign's Signet co-sign, embedded + independently verifiable"

printf '\n\033[32m✓ financial evidence-graph flow verified in the isolated sandbox\033[0m\n'
