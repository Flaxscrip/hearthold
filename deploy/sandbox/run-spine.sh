#!/usr/bin/env bash
#
# Drive the manual two-terminal spine (docs/manual-testing.md §3) end-to-end inside
# the sandbox containers, and prove each container has zero internet egress.
#
#   Emissary init → Warden init → Warden delegate → Warden serve (detached)
#   → Emissary submit ×2 → Warden vault
#
# Every DID / receipt / vault line is printed so the transcript can be folded into
# the sandbox docs. Assumes `docker compose -f docker-compose.hearthold.yml up -d
# --build` has already brought the (idle) containers up.
#
# Usage:
#   ./deploy/sandbox/run-spine.sh              # egress proof + full spine
#   ./deploy/sandbox/run-spine.sh --egress-only
#   ./deploy/sandbox/run-spine.sh --spine-only
set -euo pipefail

cd "$(dirname "$0")/../.."            # repo root (where docker-compose.hearthold.yml lives)
DC=(docker compose -f docker-compose.hearthold.yml)

# Run an agent CLI inside its container (-T: no TTY, script-safe).
agent() { local svc="$1"; shift; "${DC[@]}" exec -T "$svc" node "packages/$svc/dist/index.js" "$@"; }
first_did() { grep -oE 'did:cid:[a-z0-9]+' | head -1; }
rule() { printf '\n──────── %s ────────\n' "$*"; }

egress_proof() {
  rule "Egress isolation proof (load-bearing: each container must NOT reach the internet)"
  for svc in warden emissary sovereign; do
    printf '%-10s ' "$svc:"
    # Direct IP (no DNS) to a public host; expect ENETUNREACH, never a response.
    "${DC[@]}" exec -T "$svc" node -e '
      const http = require("http");
      const req = http.get({ host: "1.1.1.1", port: 80, timeout: 5000 }, (r) => {
        console.log("UNEXPECTED: reached the internet, status", r.statusCode); process.exit(1);
      });
      req.on("timeout", () => { console.log("UNEXPECTED: timed out (no hard-fail)"); req.destroy(); process.exit(1); });
      req.on("error", (e) => { console.log("OK isolated —", e.code, "(" + e.message + ")"); process.exit(0); });
    '
  done
  # DNS path too (an internal network has no resolver route).
  printf '%-10s ' "warden dns:"
  "${DC[@]}" exec -T warden node -e '
    require("dns").lookup("example.com", (e) => {
      if (e) { console.log("OK isolated — DNS", e.code); process.exit(0); }
      console.log("UNEXPECTED: DNS resolved"); process.exit(1);
    });
  '
}

spine() {
  rule "Emissary init"
  local EMISSARY_DID; EMISSARY_DID=$(agent emissary init | tee /dev/stderr | first_did)
  [ -n "$EMISSARY_DID" ] || { echo "FATAL: no Emissary DID"; exit 1; }

  rule "Warden init"
  local WARDEN_DID; WARDEN_DID=$(agent warden init | tee /dev/stderr | first_did)
  [ -n "$WARDEN_DID" ] || { echo "FATAL: no Warden DID"; exit 1; }

  rule "Warden delegate → Emissary ($EMISSARY_DID)"
  agent warden delegate "$EMISSARY_DID"

  rule "Warden serve (detached background process in the warden container)"
  "${DC[@]}" exec -dT warden node packages/warden/dist/index.js serve
  echo "serve started; giving the mailbox poller a moment…"; sleep 4

  rule "Emissary submit ×2 (addressed to the Warden by DID over DIDComm)"
  "${DC[@]}" exec -T -e HEARTHOLD_WARDEN_DID="$WARDEN_DID" emissary \
    node packages/emissary/dist/index.js submit location "at the corner cafe"
  "${DC[@]}" exec -T -e HEARTHOLD_WARDEN_DID="$WARDEN_DID" emissary \
    node packages/emissary/dist/index.js submit document "2025 tax return summary"
  echo "waiting for the Warden to drain + store…"; sleep 5

  rule "Warden vault (what the custodian stored — ciphertext at rest)"
  agent warden vault

  rule "Spine complete"
  echo "Warden DID:   $WARDEN_DID"
  echo "Emissary DID: $EMISSARY_DID"
}

case "${1:-all}" in
  --egress-only) egress_proof ;;
  --spine-only)  spine ;;
  all|"")        egress_proof; spine ;;
  *) echo "usage: $0 [--egress-only|--spine-only]"; exit 2 ;;
esac
