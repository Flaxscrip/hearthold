#!/usr/bin/env bash
#
# Subject-keyed R-DID — DID-aware bank onboarding in the sandbox.
#
# The Sovereign presents a pairwise R-DID it holds in its OWN (Signet) wallet and proves control of it
# DIRECTLY — the Signet answers the bank's challenge with the R-DID's own key. The Warden (custodian)
# holds no key for it and cannot answer; it never enters the signing path. The bank then binds + issues
# an AccreditedInvestor credential to the R-DID, which the Sovereign accepts on a DID it controls.
#
# This is the identity-anchor trust shape a KYC'ing institution needs, in contrast to disclosure pairwise
# (Warden-minted, the Warden presents evidence on the Sovereign's behalf). Runs in-container, isolated.
#
#   ./deploy/sandbox/run-onboarding.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
CF=docker-compose.hearthold.yml

printf '\n\033[1;36m━━ finance-onboarding — subject-keyed R-DID + prove-control ━━\033[0m\n'
printf '   \033[2mSovereign proves control of its own R-DID to a bank; Warden holds no key; bank issues AccreditedInvestor.\033[0m\n'
docker compose -f "$CF" exec -T \
  -e HEARTHOLD_DATA_ROOT=/data/flow-finance-onboarding \
  -e HEARTHOLD_CLASSIFIER=quarantine -e HEARTHOLD_INDEX=off \
  -e HEARTHOLD_PASSPHRASE=flow-finance-onboarding \
  warden node --experimental-strip-types scripts/e2e-finance-onboarding.ts 2>&1 | grep -vE 'ExperimentalWarning|trace-warning'

printf '\n\033[32m✓ subject-keyed R-DID onboarding verified in the isolated sandbox\033[0m\n'
