#!/usr/bin/env bash
#
# setup-node.sh — bootstrap a fresh, hardened, ISOLATED Aegis node.
#
# Produces a .env with values that MUST be unique per installation, generated
# here at setup time so no two installs ever share them:
#   - ARCHON_ADMIN_API_KEY        (protects admin routes)
#   - ARCHON_ENCRYPTED_PASSPHRASE (encrypts the wallet)
#   - ARCHON_PROTOCOL             (the hyperswarm topic — a UNIQUE random topic, NOT the
#                                  shared global default, so bulk gossip-sync is opt-in only)
# ...and sets the isolation defaults (local registry, no fallback, cli profile).
#
# WHY generate instead of ship a default: a hardcoded "random" topic in a committed file is
# not random — every install that copies it shares it, which is the exact footgun (a laptop of
# private history silently syncing to a stranger on the same LAN). These values are minted per
# install and never committed.
#
#   deploy/setup-node.sh            # create .env (refuses to clobber an existing one)
#   deploy/setup-node.sh --force    # overwrite an existing .env (regenerates all secrets!)
set -euo pipefail
cd "${ARCHON_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"   # archon repo root — sample.env + docker-compose.yml live here (honor ARCHON_DIR when the tooling is a sibling repo, e.g. hearthold/deploy/node)
ENV=.env

if [ -e "$ENV" ] && [ "${1:-}" != "--force" ]; then
  echo "Refusing to clobber existing $ENV (use --force to regenerate — this mints NEW secrets)." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl required" >&2; exit 1; }

cp sample.env "$ENV"

# Set (or append) KEY=VALUE in $ENV. Value handled via env vars so slashes/specials don't break.
set_env() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" "$ENV"; then
    K="$k" V="$v" perl -i -pe 's/^\Q$ENV{K}\E=.*$/$ENV{K} . "=" . $ENV{V}/e' "$ENV"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV"
  fi
}

# --- Unique per-install secrets (the whole point) ---
set_env ARCHON_ADMIN_API_KEY        "$(openssl rand -hex 32)"
set_env ARCHON_ENCRYPTED_PASSPHRASE "$(openssl rand -hex 16)"
# Unique random hyperswarm topic: bulk-sync becomes opt-in (only nodes that DELIBERATELY set the
# SAME value form a private swarm), never accidental via the shared global /ARCHON/v0.8-beta.
set_env ARCHON_PROTOCOL             "/aegis-private/$(openssl rand -hex 32)"

# --- Isolation defaults ---
set_env ARCHON_UID                             "$(id -u)"
set_env ARCHON_GID                             "$(id -g)"
# Project name `aegis` => containers are named aegis-* (this is the isolated point-to-point
# deployment, visibly distinct from stock Archon). Profiles: cli + the DIDComm relay/drawbridge
# (needed for agent messaging + cross-node credential delivery). Deliberately NOT hyperswarm or
# any btc/eth/sol/zcash mediator — those require public egress and would break isolation.
set_env COMPOSE_PROJECT_NAME                    "aegis"
set_env COMPOSE_PROFILES                       "cli,didcomm,drawbridge"
set_env ARCHON_GATEKEEPER_REGISTRIES           "local"
set_env ARCHON_DEFAULT_REGISTRY                "local"
set_env ARCHON_GATEKEEPER_FALLBACK_URL         ""
set_env ARCHON_GATEKEEPER_CONFIRM_FALLBACK_URL ""

# --- Make the file safe to `source` (a Docker .env can hold shell-illegal values; quote the ones
#     that break zsh's dotenv auto-source on cd — angle-bracket placeholders + BIP-44 paths). ---
for k in ARCHON_BTC_T4_RPC_URL ARCHON_ETH_RPC_URL \
         ARCHON_WALLET_ETH_DERIVATION_PATH ARCHON_WALLET_SOL_DERIVATION_PATH ARCHON_WALLET_FIL_DERIVATION_PATH; do
  K="$k" perl -i -pe 's/^(\Q$ENV{K}\E=)([^"].*)$/$1 . "\"" . $2 . "\""/e' "$ENV"
done

chmod 600 "$ENV"
cat <<EOF
Created a fresh, hardened, isolated .env (mode 600, gitignored):
  - unique admin key + wallet passphrase (generated)
  - unique private hyperswarm topic       (generated — never shared)
  - registry: local · fallback: none · profile: cli · internal-only network

Next:  docker compose --env-file .env up -d      (override.yml auto-loads the internal:true network)
To connect to a friend later, see deploy/two-node/README.md (peer mode is opt-in).
EOF
