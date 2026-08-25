#!/usr/bin/env bash
# aegis-sovereign-onboard.sh — initialize YOUR real Sovereign on the pi-lean node.
#
# Run at the console. Your passphrase is read HIDDEN and written to a mode-600 file on THIS box only;
# it is never printed and never leaves the Pi. Retires the throwaway measurement Sovereign, mints yours,
# and brings your Warden (:4310) + Signet (:4311) up bound to it.
set -euo pipefail

HH=/media/flaxscrip/data/Aegis/hearthold
COMPOSE="$HH/deploy/node/topology/docker-compose.pi-sovereign.yml"
SDIR=/media/flaxscrip/data/Aegis/sovereign          # the node Sovereign wallet dir
EF="$HOME/aegis-sovereign.env"                       # mode-600 secrets (passphrase + PIN + DID)
IMG=hearthold:invocation
NET=aegis_internal
bold(){ printf '\033[1;36m%s\033[0m\n' "$*"; }

bold "▸ Aegis — initialize your Sovereign"
echo "  Your passphrase encrypts your wallet. WRITE IT DOWN — there is no recovery."
echo

# 1) passphrase (hidden, entered twice)
while :; do
  read -rsp "  Sovereign passphrase (min 8): " P1; echo
  [ "${#P1}" -ge 8 ] || { echo "    at least 8 characters, please."; continue; }
  read -rsp "  confirm: " P2; echo
  [ "$P1" = "$P2" ] && break || echo "    they didn't match — try again."
done

# 2) Signet PIN (the human-consent gate for sealed disclosures)
read -rp "  Signet PIN (4 digits, gates your consent) [random]: " PIN
[ -n "${PIN:-}" ] || PIN=$(shuf -i 1000-9999 -n 1)

# 3) write mode-600 secrets (passphrase never echoed)
( umask 077; printf 'HEARTHOLD_PASSPHRASE=%s\nHEARTHOLD_SIGNET_PIN=%s\n' "$P1" "$PIN" > "$EF" )
unset P1 P2; chmod 600 "$EF"
echo "  ✓ secrets stored mode-600 → $EF   (Signet PIN: $PIN)"

# 4) retire the throwaway measurement Sovereign + wipe its wallet (encrypted with the old throwaway key)
bold "▸ Retiring the measurement Sovereign…"
docker ps -aq --filter name=aegis-sovereign | xargs -r docker rm -f >/dev/null 2>&1 || true
sudo rm -rf "$SDIR"; mkdir -p "$SDIR"
rm -f "$HOME/aegis-sovereign-measure.env" 2>/dev/null || true

# 5) mint YOUR Sovereign (auto-creates the wallet + DID on the local registry via gatekeeper:4224)
#    NOTE: pass secrets via docker --env-file, NEVER `source` the file — a passphrase with a space/shell
#    metacharacter would be mis-parsed by the shell. --env-file reads KEY=VALUE literally.
bold "▸ Minting your Sovereign identity…"
INIT_OUT=$(docker run --rm --env-file "$EF" --network "$NET" -v "$SDIR":/data \
  -e HEARTHOLD_DATA_ROOT=/data -e HEARTHOLD_NODE_URL=http://gatekeeper:4224 -e HEARTHOLD_REGISTRY=local \
  "$IMG" node packages/sovereign/dist/index.js init 2>&1 | grep -viE 'ExperimentalWarning|trace-warning')
echo "$INIT_OUT" | sed 's/^/    /'
DID=$(echo "$INIT_OUT" | grep -oE 'did:cid:[a-z0-9]+' | head -1)
[ -n "$DID" ] || { echo "  ✗ could not read the new DID — see output above"; exit 1; }
grep -q '^HEARTHOLD_SOVEREIGN_DID=' "$EF" || echo "HEARTHOLD_SOVEREIGN_DID=$DID" >> "$EF"

# 6) bring your custodian up on your DID (--env-file supplies the secrets; non-secret vars via the shell env)
bold "▸ Bringing up your Warden + Signet…"
( cd "$HH"
  export HEARTHOLD_DOCKER_NETWORK="$NET" AEGIS_IMAGE="$IMG" WARDEN_DATA_ROOT="$SDIR" HEARTHOLD_SOVEREIGN_DID="$DID"
  docker compose -p aegis-sovereign --env-file "$EF" -f "$COMPOSE" up -d )
sleep 6
echo
bold "✓ Your Sovereign is live"
echo "  DID:     $DID"
echo "  Warden:  http://127.0.0.1:4310      Signet: http://127.0.0.1:4311  (PIN $PIN)"
docker ps --filter name=aegis-sovereign --format '  {{.Names}}   {{.Status}}'
echo
echo "  Secrets live in $EF (mode-600). The daemons read your passphrase from it to unlock the wallet."
