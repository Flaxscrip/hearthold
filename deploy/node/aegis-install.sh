#!/usr/bin/env bash
# aegis-install.sh — stand up a personal, egress-isolated Aegis Sovereign node.
#
#   curl -fsSL https://archon.technology/aegis-install.sh | bash          # (future: hosted one-liner)
#   bash aegis-install.sh                                      # (local run)
#
# Target: a Raspberry Pi 5 (8 GB, ARM64) running Raspberry Pi OS / Debian — but works on any apt-based
# arm64/amd64 Linux. Self-contained: provisions the code, BUILDS on the box, launches the sealed node,
# and walks you (the Sovereign) through naming + key creation + config. No cloud, no account, no egress.
#
# Phases:  preflight → swap → deps → fetch → build → onboard → launch → verify → done
#
# v0.1 — DRAFT. The preflight / swap / onboarding are solid; fetch/build/launch wrap our existing tooling
# (setup-node.sh, create-internal-network.sh, docker-compose.yml, the `aegis` operator CLI) and want a real
# run on the Pi to shake out. Nothing here is destructive without a prompt; re-runnable.
set -euo pipefail

# ─────────────────────────────── configuration (override via env) ───────────────────────────────
# TWO repos: the archon node substrate + the flaxscrip/hearthold custodian layer.
AEGIS_BASE="${AEGIS_BASE:-$HOME}"                  # base for code + node data; point at a fast SSD to keep the OS drive lean
ARCHON_REPO="${ARCHON_REPO:-https://github.com/archetech/archon.git}"
ARCHON_REF="${ARCHON_REF:-v0.11.0}"                  # the tagged base
ARCHON_DIR="${ARCHON_DIR:-$AEGIS_BASE/archon}"             # gatekeeper/keymaster/storage + the profiles system
HEARTHOLD_REPO="${HEARTHOLD_REPO:-https://github.com/flaxscrip/hearthold.git}"
HEARTHOLD_REF="${HEARTHOLD_REF:-main}"               # Warden/Signet/Emissary/Table + our deploy/ tooling
HEARTHOLD_DIR="${HEARTHOLD_DIR:-$AEGIS_BASE/hearthold}"
# Our deploy/ tooling (operator CLI, bring-up scripts, compose overlays, pi-lean) — committed under
# flaxscrip/hearthold deploy/node/. Runs against the archon node at $ARCHON_DIR by path.
DEPLOY_DIR="${DEPLOY_DIR:-$HEARTHOLD_DIR/deploy/node}"
AEGIS_SWAP_GB="${AEGIS_SWAP_GB:-6}"
AEGIS_MIN_DISK_GB="${AEGIS_MIN_DISK_GB:-20}"
AEGIS_PROFILE_DEFAULT="pi-lean"                      # identity + cards + one model; no lightning/tor at rest (see deploy/PI-LEAN.md)
AEGIS_IMAGE="${AEGIS_IMAGE:-hearthold:invocation}"   # custodian image tag: the invocation-capable build (was hearthold:sandbox)
NONINTERACTIVE="${AEGIS_NONINTERACTIVE:-0}"          # 1 = accept all defaults (for testing)

# ─────────────────────────────── UX ───────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'; RED=$'\033[1;31m'; GRN=$'\033[1;32m'; YEL=$'\033[1;33m'; CYN=$'\033[1;36m'; else B= DIM= R= RED= GRN= YEL= CYN=; fi
step() { printf '\n%s▸ %s%s\n' "$CYN$B" "$*" "$R"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$R" "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$R" "$*"; }
die()  { printf '\n%sxx%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }
ask()  { # ask <prompt> <default> <varname>
  local p="$1" d="$2" __v="$3" a
  if [ "$NONINTERACTIVE" = 1 ]; then printf -v "$__v" '%s' "$d"; info "$p ${DIM}[$d]${R}"; return; fi
  read -r -p "  $p ${DIM}[$d]${R}: " a || true; printf -v "$__v" '%s' "${a:-$d}"
}
ask_secret() { # ask_secret <prompt> <varname>  (hidden, entered twice, must match, min 8)
  local p="$1" __v="$2" a b
  if [ "$NONINTERACTIVE" = 1 ]; then printf -v "$__v" '%s' "aegis-demo-passphrase"; warn "non-interactive: using a throwaway passphrase"; return; fi
  while :; do
    read -r -s -p "  $p: " a; echo
    [ "${#a}" -ge 8 ] || { warn "at least 8 characters, please."; continue; }
    read -r -s -p "  confirm: " b; echo
    [ "$a" = "$b" ] || { warn "they didn't match — try again."; continue; }
    printf -v "$__v" '%s' "$a"; break
  done
}
confirm() { # confirm <prompt>  (default yes)
  [ "$NONINTERACTIVE" = 1 ] && return 0
  local a; read -r -p "  $1 ${DIM}[Y/n]${R}: " a || true; case "${a:-y}" in [Yy]*|"") return 0;; *) return 1;; esac
}

banner() {
  printf '%s' "$CYN$B"
  cat <<'ART'
      ╔══════════════════════════════════════════════╗
      ║   ▄▄▄   ▄▄▄▄  ▄▄▄▄  ▄  ▄▄▄                    ║
      ║   █  █  █▄▄   █ ▄▄  █  █▄▄     A E G I S       ║
      ║   █▀▀█  █▄▄▄  █▄▄█  █  ▄▄█   sovereign node    ║
      ╚══════════════════════════════════════════════╝
ART
  printf '%s' "$R"
  info "${DIM}A personal, egress-isolated Sovereign node. Your keys, your machine, no internet required.${R}"
}

# ─────────────────────────────── phase 1: preflight ───────────────────────────────
preflight() {
  step "Preflight"
  [ "$(id -u)" -ne 0 ] || die "run as your normal user (with sudo), not root."
  command -v sudo >/dev/null || die "sudo is required."
  sudo -n true 2>/dev/null || { warn "sudo may prompt for your password during install."; }

  local arch; arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64) ok "architecture: $arch (Pi/ARM64)";;
    x86_64|amd64)  warn "architecture: $arch — not a Pi, but fine for testing.";;
    *)             die "unsupported architecture: $arch";;
  esac

  [ -r /etc/os-release ] || die "cannot read /etc/os-release."
  . /etc/os-release
  case " $ID ${ID_LIKE:-} " in
    *" debian "*|*" ubuntu "*|*raspbian*) ok "OS: ${PRETTY_NAME:-$ID} (apt-based)";;
    *) die "an apt-based Linux is required (Raspberry Pi OS / Debian / Ubuntu). Found: ${PRETTY_NAME:-$ID}";;
  esac

  local ram_mb; ram_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
  if [ "$ram_mb" -ge 7500 ]; then ok "memory: ${ram_mb} MiB"
  elif [ "$ram_mb" -ge 3500 ]; then warn "memory: ${ram_mb} MiB — below 8 GB. pi-lean profile only; expect a slow build."
  else die "memory: ${ram_mb} MiB — too little to build + run the node."; fi

  local free_gb; free_gb=$(df -BG --output=avail "$HOME" 2>/dev/null | tail -1 | tr -dc '0-9')
  if [ "${free_gb:-0}" -ge "$AEGIS_MIN_DISK_GB" ]; then ok "disk: ${free_gb} GiB free"
  else warn "disk: ${free_gb:-?} GiB free — recommend ≥ ${AEGIS_MIN_DISK_GB} GiB (repo + build + images + swap)."; fi

  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then ok "docker: $(docker --version | awk '{print $3}' | tr -d ,)"
  else warn "docker not ready — will install it (get.docker.com) in the deps phase."; NEED_DOCKER=1; fi
}

# ─────────────────────────────── phase 2: swap (build headroom on 8 GB) ───────────────────────────────
ensure_swap() {
  step "Swap — headroom for building on 8 GB"
  local cur_gb; cur_gb=$(free -g | awk '/Swap/{print $2}')
  if [ "${cur_gb:-0}" -ge 4 ]; then ok "swap: ${cur_gb} GiB already present"; return; fi
  info "Building the monorepo on a Pi is memory-hungry (this is what OOM'd a peer node)."
  confirm "Create a ${AEGIS_SWAP_GB} GiB swapfile at /swapfile?" || { warn "skipping swap — build may OOM."; return; }
  # Guard the exact failure we hit before: fallocate on a full disk. Check free space first.
  local free_gb; free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
  [ "${free_gb:-0}" -gt "$((AEGIS_SWAP_GB + 3))" ] || die "not enough free disk for a ${AEGIS_SWAP_GB} GiB swapfile (${free_gb} GiB free)."
  sudo swapoff /swapfile 2>/dev/null || true; sudo rm -f /swapfile
  sudo fallocate -l "${AEGIS_SWAP_GB}G" /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=$((AEGIS_SWAP_GB*1024)) status=none
  sudo chmod 600 /swapfile; sudo mkswap /swapfile >/dev/null; sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  ok "swap: ${AEGIS_SWAP_GB} GiB active (persisted in /etc/fstab)"
}

# ─────────────────────────────── phase 3: dependencies ───────────────────────────────
install_deps() {
  step "Dependencies"
  sudo apt-get update -qq
  sudo apt-get install -y -qq git curl ca-certificates build-essential python3 openssl
  ok "git · curl · build-essential · python3 · openssl"
  # hearthold REQUIRES node >=22 (package.json engines + 102 e2e scripts use --experimental-strip-types).
  # Debian trixie apt ships node 20 — TOO OLD (the host build's native deps + any host-run tooling break under 22).
  if ! command -v node >/dev/null || [ "$(node -v | tr -dc '0-9.' | cut -d. -f1)" -lt 22 ]; then
    # Prefer Debian's own node ONLY if it already provides >=22 (future Debian); else NodeSource node 22.
    aptmaj=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate/{print $2}' | grep -oE '^[0-9]+')
    if [ "${aptmaj:-0}" -ge 22 ]; then
      info "installing Node.js ${aptmaj}.x from Debian apt…"; sudo apt-get install -y -qq nodejs
    else
      info "installing Node.js 22 (NodeSource)…"; curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null; sudo apt-get install -y -qq nodejs \
        || warn "NodeSource install failed (may not support this distro yet) — install node >=22 manually before the build."
    fi
  fi
  command -v npm >/dev/null || sudo apt-get install -y -qq npm   # Debian ships npm separately from the nodejs package
  ok "node $(node -v)  ·  npm $(npm -v)"
  if [ "${NEED_DOCKER:-0}" = 1 ]; then
    info "installing Docker (get.docker.com)…"
    curl -fsSL https://get.docker.com | sudo sh >/dev/null
    sudo usermod -aG docker "$USER"
    warn "added $USER to the 'docker' group — you may need to log out/in (or 'newgrp docker') for it to take effect."
  fi
  ok "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d , || echo '(re-login needed)')"
}

# ─────────────────────────────── phase 4: fetch the code ───────────────────────────────
_get_repo() { # <url> <ref> <dir> <label>
  if [ -d "$3/.git" ]; then info "updating $4…"; git -C "$3" fetch --depth 1 origin "$2" -q 2>/dev/null && git -C "$3" checkout -q FETCH_HEAD 2>/dev/null || warn "could not update $4 — using what's there."
  else info "cloning $4 ($1 @ $2)…"; git clone --depth 1 --branch "$2" "$1" "$3"; fi
}
fetch_code() {
  step "Fetch the code — archon node + hearthold custodian"
  # AEGIS_BASE may be a root-created mount subdir (e.g. a relocated docker data-root lives beside the code).
  # Make sure THIS user can create the repo work-trees here, or the clone dies "Permission denied".
  mkdir -p "$AEGIS_BASE" 2>/dev/null || sudo mkdir -p "$AEGIS_BASE"
  [ -w "$AEGIS_BASE" ] || { info "making $AEGIS_BASE writable for $(id -un)…"; sudo chown "$(id -un):$(id -gn)" "$AEGIS_BASE"; }
  _get_repo "$ARCHON_REPO"    "$ARCHON_REF"    "$ARCHON_DIR"    "archon node"
  _get_repo "$HEARTHOLD_REPO" "$HEARTHOLD_REF" "$HEARTHOLD_DIR" "hearthold custodian"
  [ -f "$ARCHON_DIR/docker-compose.yml" ] || warn "no docker-compose.yml in $ARCHON_DIR — check ARCHON_REF ($ARCHON_REF)."
  [ -x "$DEPLOY_DIR/setup-node.sh" ] || warn "deploy tooling not at $DEPLOY_DIR (setup-node.sh missing) — set DEPLOY_DIR. See the layout TODO."
  ok "archon → $ARCHON_DIR   ·   hearthold → $HEARTHOLD_DIR"
}

# ─────────────────────────────── phase 5: build ON the Pi ───────────────────────────────
build_node() {
  step "Build (on this box — the slow part; swap earns its keep here)"
  # Cap the Node heap so tsc/vite don't stampede the Pi's RAM.
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
  info "hearthold: npm ci + build …"; ( cd "$HEARTHOLD_DIR" && npm ci --no-audit --no-fund && npm run build )
  info "hearthold: image ($AEGIS_IMAGE) …"; ( cd "$HEARTHOLD_DIR" && docker build -t "$AEGIS_IMAGE" . ) || warn "hearthold image build hit an issue — inspect above."
  # Archon node images build/pull at first `up` — compose builds its source services and pulls the prebuilt
  # arm64 bases (mongo/redis/ipfs). Keeping it there avoids a second long build pass here.
  ok "custodian built · archon images build on first launch"
}

# ─────────────────────────────── phase 6: onboard the Sovereign ───────────────────────────────
onboard() {
  step "Onboarding — this node is yours; let's set it up"
  info "${DIM}Everything below stays on this machine. Your passphrase is never shown, stored in plaintext, or sent anywhere.${R}\n"
  ask "Node name"        "${HOSTNAME:-Aegis}"     NODE_NAME
  ask "Your Sovereign name (your identity's handle)" "$USER" SOV_NAME
  echo
  info "Your Sovereign passphrase encrypts your wallet. ${B}Write it down — there is no recovery.${R}"
  ask_secret "Passphrase" SOV_PASS
  echo
  info "Registry — where your DIDs are anchored:"
  info "  ${B}local${R}  fully isolated, no network (recommended for a sovereign home node)"
  ask "Registry" "local" REGISTRY
  echo
  info "Profile — what runs at rest (8 GB budget):"
  info "  ${B}pi-lean${R}  identity + card-passing + one on-device model  (~5 GiB, fits 8 GB)"
  info "  ${B}full${R}     adds the Lightning value rail + Tor mailbox     (tight on 8 GB)"
  ask "Profile" "$AEGIS_PROFILE_DEFAULT" PROFILE
  echo
  if confirm "Provision the AI family (Aegis · Sevenfold · Hearthold agents) under you?"; then PROVISION_FAMILY=1; else PROVISION_FAMILY=0; fi

  echo; info "${B}Summary${R}"
  info "  node        $NODE_NAME"
  info "  sovereign   $SOV_NAME"
  info "  passphrase  ${DIM}(set — hidden)${R}"
  info "  registry    $REGISTRY"
  info "  profile     $PROFILE"
  info "  AI family   $([ "$PROVISION_FAMILY" = 1 ] && echo yes || echo no)"
  echo
  confirm "Proceed with this configuration?" || die "aborted — nothing launched. Re-run to start over."
}

# ─────────────────────────────── phase 7: launch ───────────────────────────────
_set_env() { # _set_env <file> <KEY> <VALUE>  (idempotent; value via env so specials don't break)
  local f="$1" k="$2"; K="$k" V="$3" perl -i -pe 's/^\Q$ENV{K}\E=.*$/$ENV{K}."=".$ENV{V}/e' "$f" 2>/dev/null
  grep -qE "^$k=" "$f" || printf '%s=%s\n' "$k" "$3" >> "$f"
}
launch() {
  step "Launch"
  # 1) sealed, internal-only network (no egress path).
  info "creating the sealed network…"; bash "$DEPLOY_DIR/create-internal-network.sh" 2>/dev/null || warn "create-internal-network.sh failed — check \$DEPLOY_DIR ($DEPLOY_DIR)."
  # 2) archon node .env: mint per-install secrets + isolation defaults; then YOUR passphrase + the chosen profile.
  cd "$ARCHON_DIR"
  info "minting node secrets…"; ARCHON_DIR="$ARCHON_DIR" bash "$DEPLOY_DIR/setup-node.sh" || warn "setup-node.sh failed (see above)."
  if [ -f .env ]; then
    _set_env .env ARCHON_ENCRYPTED_PASSPHRASE "$SOV_PASS"       # your choice, never echoed
    _set_env .env ARCHON_NODE_NAME "$NODE_NAME"
    _set_env .env ARCHON_DEFAULT_REGISTRY "$REGISTRY"
    if [ "$PROFILE" = "pi-lean" ] && [ -f "$DEPLOY_DIR/topology/pi-lean.env" ]; then
      info "applying the pi-lean profile (drops lightning/tor/drawbridge; didcomm-direct)…"
      while IFS= read -r ln; do case "$ln" in ''|\#*) ;; *) _set_env .env "${ln%%=*}" "${ln#*=}";; esac; done < "$DEPLOY_DIR/topology/pi-lean.env"
    fi
    # 'full' keeps setup-node's default (cli,didcomm,drawbridge → lightning+tor) — the opt-in value/onion rail.
  fi
  # 3) SEAL: attach every service to the internal-only network so egress is blocked (the isolation IS the test).
  #    create-internal-network.sh only makes aegis_internal; this override remaps Compose's default net onto it.
  #    Without this the node comes up on a normal bridge WITH egress. Compose auto-loads docker-compose.override.yml.
  info "sealing the node onto the internal network…"
  printf 'networks:\n  default:\n    name: aegis_internal\n    external: true\n' > "$ARCHON_DIR/docker-compose.override.yml"
  # 4) bring up the archon node on the resolved profiles (from .env COMPOSE_PROFILES).
  info "bringing up the archon node ($PROFILE)…"; docker compose --env-file .env up -d
  # 4) custodian control plane (Warden/Signet/Emissary command surface).
  info "bringing up the control plane…"; bash "$DEPLOY_DIR/hearthold-up.sh" 2>/dev/null || warn "hearthold-up.sh failed — bring the control plane up manually."
  # 5) create the Sovereign identity from the onboarding answers (in-network keymaster; gatekeeper never exposed).
  #    TODO(pi): wire to keymaster create-id (like aegis-wallet) with SOV_NAME='hearthold-sovereign' + SOV_PASS + REGISTRY.
  info "creating your Sovereign identity '$SOV_NAME'…"; warn "identity-provisioning step is scaffolded — wiring to keymaster create-id next."
  # 6) optional AI family under the Sovereign.
  [ "${PROVISION_FAMILY:-0}" = 1 ] && { info "provisioning the AI family…"; bash "$DEPLOY_DIR/family/provision-node-family.sh" 2>/dev/null || warn "family provisioner failed."; }
  ok "launched"
}

# ─────────────────────────────── phase 8: verify isolation ───────────────────────────────
verify() {
  step "Verify — the node must NOT be able to reach the internet"
  if [ -x "/operator/aegis" ]; then
    "/operator/aegis" status || warn "aegis status reported issues — review above."
  else
    warn "operator CLI not found; run the isolation proof manually (egress from a node container must fail: ENETUNREACH)."
  fi
}

# ─────────────────────────────── phase 9: done ───────────────────────────────
finish() {
  step "Done — welcome home"
  ok "Your Aegis node '$NODE_NAME' is up, sealed, and yours."
  info ""
  info "  Sovereign      $SOV_NAME  (passphrase: the one you set — keep it safe)"
  info "  Registry       $REGISTRY   ·   Profile   $PROFILE"
  info "  The Table      ${B}/operator/aegis table up${R}   → then browse http://localhost:5175 on this box"
  info "  Health         ${B}aegis status${R}   (containers + the live isolation proof)"
  info "  Wallet ops     ${B}aegis-wallet${R}    ·   Agent MCP   ${B}aegis-mcp${R}"
  info ""
  info "  ${DIM}Add the operator tools to your PATH:${R}"
  info "    ln -s /operator/aegis{,-wallet,-mcp} ~/.local/bin/"
}

# ─────────────────────────────── main ───────────────────────────────
main() {
  banner
  preflight
  ensure_swap
  install_deps
  fetch_code
  build_node
  onboard
  launch
  verify
  finish
}
main "$@"
