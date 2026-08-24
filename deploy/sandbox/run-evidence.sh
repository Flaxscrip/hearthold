#!/usr/bin/env bash
#
# Evidence-graph flow in the sandbox — the "prove a fact without disclosing the data" half of Hearthold.
# The Warden assembles supporting observations from the vault into a Merkle-rooted, SIGNED evidence graph
# (trust class: witnessed); a verifier verifies it against the Warden's signature; selective disclosure
# reveals one supporting fact and hides the rest; and the Sovereign's Signet co-sign (a step-up over
# DIDComm) is embedded so a third party can verify the human approval without decrypting anything.
#
# Runs the proven flows IN-CONTAINER against the isolated node (local registry + the DIDComm endpoint
# override), each in its own throwaway data root so it never touches the demo agents' identities.
#
#   ./deploy/sandbox/run-evidence.sh
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

flow evidence           "assemble observations → mint a signed evidence graph → present → verify (witnessed)"
flow evidence-selective "A3 — reveal ONE supporting fact against the signed Merkle root; the rest stay hidden"
flow evidence-stepup    "A2 — the Sovereign's Signet co-sign, embedded + independently verifiable (step-up over DIDComm)"

printf '\n\033[32m✓ evidence-graph flow verified in the isolated sandbox\033[0m\n'
