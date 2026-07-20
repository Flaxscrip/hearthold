#!/usr/bin/env bash
#
# The prove flow in the sandbox — exercises the Sovereign's SIGNET end-to-end.
#
# A guild manager issues a GuildMembership credential to the Sovereign; a verifier then challenges the
# Sovereign to prove it holds one, which routes to the Sovereign's `serve` loop and prompts the Signet
# for your PIN. Trust rests on the ISSUER's signature, not the Warden's.
#
#   ./deploy/sandbox/run-prove.sh setup          # issuer + credential + verifier (one-time; idempotent)
#   ./deploy/sandbox/run-prove.sh signet [pin]   # TERMINAL A — the Signet (interactive PIN gate)
#   ./deploy/sandbox/run-prove.sh verify         # TERMINAL B — the verifier requests → prompts A
#
# `signet` stays running and prompts on each disclosure; run `verify` in a second terminal.
set -euo pipefail

cd "$(dirname "$0")/../.."                 # repo root
CF=docker-compose.hearthold.yml
STATE=./data/.prove-flow                    # persisted DIDs (gitignored — data/ is)
ISSUER_ROOT=/data/guild-manager             # a DISTINCT data root → a distinct issuer identity

sov()    { docker compose -f "$CF" exec -T sovereign node packages/sovereign/dist/index.js "$@"; }
issuer() { docker compose -f "$CF" exec -T -e HEARTHOLD_DATA_ROOT="$ISSUER_ROOT" sovereign node packages/sovereign/dist/index.js "$@"; }
ver()    { docker compose -f "$CF" exec -T verifier node packages/verifier/dist/index.js "$@"; }
did()    { grep -oE 'did:cid:[a-z0-9]+' | head -1; }

case "${1:-setup}" in
  setup)
    echo "▸ Sovereign identity (the credential holder / presenter)"
    SOV_DID=$(sov init | tee /dev/stderr | did)
    echo "▸ Guild manager (issuer) — a distinct identity via its own data root ($ISSUER_ROOT)"
    ISSUER_DID=$(issuer init | tee /dev/stderr | did)
    echo "▸ Issue GuildMembership → the Sovereign"
    OUT=$(issuer issue "$SOV_DID" GuildMembership 'guild=Aegis Sandbox Guild' role=Raid-Lead); echo "$OUT"
    CRED_DID=$(echo "$OUT" | grep -iE 'credential:' | did)
    SCHEMA_DID=$(echo "$OUT" | grep -iE '^[[:space:]]*schema:' | did)
    echo "▸ Sovereign accepts the credential into its vault"
    sov accept "$CRED_DID"
    echo "▸ Verifier identity"
    ver init >/dev/null && echo "  verifier ready"
    mkdir -p ./data
    printf 'SOV_DID=%s\nISSUER_DID=%s\nSCHEMA_DID=%s\nCRED_DID=%s\n' "$SOV_DID" "$ISSUER_DID" "$SCHEMA_DID" "$CRED_DID" > "$STATE"
    cat <<EOF

✓ Prove flow ready.
  Sovereign (presenter):  $SOV_DID
  Guild manager (issuer): $ISSUER_DID
  Schema (GuildMembership): $SCHEMA_DID
  Credential:             $CRED_DID

Now, in TWO terminals:
  A)  ./deploy/sandbox/run-prove.sh signet 1379     # the Signet — waits, prompts for the PIN
  B)  ./deploy/sandbox/run-prove.sh verify          # the verifier requests → the Signet prompts in A
      (type 1379 in A to approve → B prints ✓ VERIFIED with role=Raid-Lead; blank to deny)
EOF
    ;;
  signet)
    PIN="${2:-1379}"
    echo "Signet serving — will prompt for your PIN on each disclosure (Ctrl-C to stop)."
    exec docker compose -f "$CF" exec -it -e HEARTHOLD_SIGNET_PIN="$PIN" sovereign \
      node packages/sovereign/dist/index.js serve
    ;;
  verify)
    [ -f "$STATE" ] || { echo "run './deploy/sandbox/run-prove.sh setup' first"; exit 1; }
    # shellcheck disable=SC1090
    . "$STATE"
    echo "Verifier → prove the Sovereign holds a GuildMembership (role=Raid-Lead)…"
    ver verify "$SOV_DID" "$SCHEMA_DID" "$ISSUER_DID" role=Raid-Lead
    ;;
  *) echo "usage: $0 [setup | signet [pin] | verify]"; exit 2 ;;
esac
