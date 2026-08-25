#!/usr/bin/env bash
# aegis-authorize-family.sh — Signet-GATED family authorization.
#
# The PROPER "Governor authorizes a new family member" flow: for each agent, this asks your Signet to admit it,
# which PENDS until YOU approve with your PIN — only then does your key sign the allowance. Replaces the batch
# provisioner's non-interactive signing. Run at the console (needs the family-gate image on your Signet).
set -uo pipefail
SIGNET="${SIGNET_URL:-http://127.0.0.1:4311}"
ROSTER=/media/flaxscrip/data/Aegis/agents/identities/agents/roster.json
AGENTS_ROOT=/media/flaxscrip/data/Aegis/agents/identities/agents

command -v python3 >/dev/null || { echo "python3 required"; exit 1; }
[ -f "$ROSTER" ] || { echo "no roster at $ROSTER"; exit 1; }
curl -sS -m 5 "$SIGNET/api/status" >/dev/null 2>&1 || { echo "Signet not reachable at $SIGNET"; exit 1; }
# route present?
if ! curl -sS -m 5 -X POST "$SIGNET/api/authorize-family-member" -H 'content-type: application/json' -d '{}' 2>/dev/null | grep -q 'agentDid is required'; then
  echo "The /api/authorize-family-member route is not on this Signet yet (deploy the family-gate image first)."; exit 1
fi

read -rsp "Your Signet PIN: " PIN; echo; echo
printf '%s\n' "$(python3 -c "import json;[print(n, a['did']) for n,a in json.load(open('$ROSTER'))['agents'].items()]")" | while read -r name did; do
  [ -n "$name" ] || continue
  echo "── $name  $did ──"
  resp=$(mktemp)
  # fire the authorization — it BLOCKS pending your PIN approval
  curl -sS -m 300 -X POST "$SIGNET/api/authorize-family-member" -H 'content-type: application/json' \
    -d "{\"agentDid\":\"$did\",\"agentName\":\"$name\",\"selfLimit\":2000,\"ceiling\":\"MEDIUM\"}" > "$resp" &
  cpid=$!
  # find the pending approval this raised
  id=""; summary=""
  for _ in $(seq 1 40); do
    read -r id summary < <(curl -sS -m 5 "$SIGNET/api/snapshot" 2>/dev/null | python3 -c "
import sys,json
try: p=json.load(sys.stdin).get('pending',[])
except Exception: p=[]
for x in p:
    if x.get('resource')=='$did' or '$did' in json.dumps(x):
        print(x['id'], x.get('summary','')); break
" 2>/dev/null)
    [ -n "$id" ] && break
    sleep 0.5
  done
  if [ -z "$id" ]; then echo "  ✗ no pending approval appeared"; kill "$cpid" 2>/dev/null; wait "$cpid" 2>/dev/null; rm -f "$resp"; continue; fi
  echo "  you are approving: $summary"
  curl -sS -m 10 -X POST "$SIGNET/api/approve" -H 'content-type: application/json' \
    -d "{\"id\":\"$id\",\"approve\":true,\"pin\":\"$PIN\"}" >/dev/null 2>&1
  wait "$cpid" 2>/dev/null
  if python3 -c "import sys,json; sys.exit(0 if json.load(open('$resp')).get('authorized') else 1)" 2>/dev/null; then
    werr=$(mktemp)
    if python3 -c "import json; d=json.load(open('$resp')); open('$AGENTS_ROOT/$name/ruleset.json','w').write(json.dumps(d['ruleset'],indent=2)+'\n')" 2>"$werr"; then
      echo "  ✓ authorized at your Signet + Signet-signed allowance SAVED to $name/ruleset.json"
    else
      echo "  ⚠ authorized at your Signet, but could NOT save the ruleset: $(tr -d '\n' <"$werr" | tail -c 200)"
    fi
    rm -f "$werr"
  else
    echo "  ✗ NOT authorized (declined/PIN mismatch): $(cat "$resp")"
  fi
  rm -f "$resp"
done
echo
echo "Done — each agent's allowance is now signed ONLY after your PIN approval at the Signet."
