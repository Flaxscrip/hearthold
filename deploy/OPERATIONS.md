# Hearthold — Operations Log & Maintenance Runbook

Running record of infra/operational changes to the hosted deployment on **archon**
(`74.208.222.204`), plus the recurring procedures for maintaining and upgrading it.
Append a dated entry here whenever you change the live system.

Deployment topology and first-time install live in [`INSTALL.md`](./INSTALL.md); this
file is the change history and the "how we operate it" companion.

## Current shape (at a glance)

- **Warden** (custodian + vault, KB `hearthold-kb`) — `hearthold-warden.service`, data root
  `~/.hearthold-warden`, env `/opt/hearthold/.env.warden` (0600). DID `…r4tt4od…`.
- **Emissary** (world-facing KB portal bridge) — `hearthold-kb-mage.service`, data root
  `~/.hearthold-kb-mage`, env `/opt/hearthold/.env.kb-mage` (0600), loopback `:4313` behind nginx.
- **Node**: local Archon Drawbridge `localhost:4222`. **Classifier**: Ollama `qwen3:8b` @ `megaflax` (only off-box dep).
- **Public portal**: `https://kb.archon.social` (nginx TLS → loopback Emissary).

## Backups

Durable operational backups live **outside this repo, under `~/infra-backups/`**, on purpose:
the Warden data root contains the encrypted wallet, and configs reference secrets. **Never commit
backup archives or env files** — only reference them here.

| What | Location |
|------|----------|
| Warden data root (wallet + vault + KB config + partitions), pre-KB-Spaces | `~/infra-backups/hearthold-warden/hearthold-warden-PRE-kbspaces-20260713-204144.tgz` |
| `archon.technology` nginx vhost, pre/post rate-limit bump + note | `~/infra-backups/nginx/archon.technology.conf.{PRE,POST}-ratelimit-20260713-203110`, `README-20260713-203110.txt` |

---

## Change log (newest first)

### 2026-07-13 — Upgrade to KB Spaces; enable per-member private partitions on `hearthold-kb`
- **Commit**: pulled `ad62411` (`warden: kb-spaces enable`), rebuilt `dist/`.
- **What**: ran `warden kb-spaces enable --default-scope shared --kb hearthold-kb`. Retrofit
  per-member private partitions onto the existing shared KB — **non-destructive** (47 shared
  artefacts intact and still recall) and **idempotent**. Backfilled a private partition for all
  5 members; owner `flaxscrip` (`did:cid:bagaaiera7vsjlu…`) owns `hearthold-kb::priv:d0746da7a089d9ac`.
- **Default scope = shared**: the collaborative KB behaves as before; private is opt-in via the
  portal toggle.
- **Procedure** (wallet-mutating — see runbook): stop `hearthold-warden` → back up data root →
  `kb-spaces enable` → verify `kb-status` + `hearthold-partitions.json` → start service.
- **Backup**: `~/infra-backups/hearthold-warden/hearthold-warden-PRE-kbspaces-20260713-204144.tgz`.
- **New members** granted after this automatically get a private partition (the `kb-grant` path
  provisions one when `memberPartitions` is on) — no re-run needed.

### 2026-07-13 — nginx rate-limit bump on `archon.technology` (fix wallet-auth CORS-masked 429s)
- **File**: `/etc/nginx/sites-available/archon.technology.conf` (shared Archon vhost — not in this repo).
- **What**: `api_general` zone `rate=30r/s → 100r/s` (line 48); `/api/v1/did/did:*` route
  `burst=30 → 60` (line 242). Applied with `sudo nginx -t && sudo systemctl reload nginx`.
- **Why**: `wallet.archon.technology` login fires a burst of `did:cid` resolutions against
  `archon.technology/api/v1/did/…`. The 30 r/s ceiling returned 429s, and that route carries **no
  nginx CORS header** (Drawbridge/Express owns CORS on `/api/v1/*`; the `proxy-cors.conf` snippet is
  intentionally empty), so the browser reported *"No 'Access-Control-Allow-Origin' header is present"*
  — masking the real 429. Bump gave headroom; auth verified working.
- **Revert**: `sudo cp ~/infra-backups/nginx/archon.technology.conf.PRE-ratelimit-20260713-203110 \
  /etc/nginx/sites-available/archon.technology.conf && sudo nginx -t && sudo systemctl reload nginx`.
- **Known follow-up (not yet applied)**: because that route has no nginx-level CORS fallback, *any*
  pre-backend error (429/502/504) surfaces as a misleading CORS error. A robust fix is to make nginx
  the sole CORS authority on `/api/v1/*` (`proxy_hide_header Access-Control-Allow-Origin;` +
  `add_header … $cors_origin always;`) so errors carry the header and are legible. Deferred — rate
  bump resolved the immediate issue.

### 2026-07-13 — Co-locate Warden on archon; retire flaxlap
- **Commit**: `b27eafe` (`deploy: run Warden on archon …`) — adds `hearthold-warden.service`, updates `INSTALL.md`.
- **What**: migrated the KB Warden's vault from flaxlap to `~/.hearthold-warden` on archon and stood
  it up as a systemd service. The Warden `did:cid` was **preserved** through the migration (it's
  anchored on the archon node), so the Emissary needed no reconfig. flaxlap's `warden serve` was then
  stopped and flaxlap retired — archon is the sole custodian (no split-brain).
- **Remaining off-box dependency**: `megaflax` for the Ollama classifier (intentional).

---

## Maintenance runbook

### Upgrade in place (pull a new release)
```bash
cd /opt/hearthold && git pull --ff-only origin main && npm run build
# restart the services whose compiled code changed (both share the wire protocol → restart together):
sudo systemctl restart hearthold-warden hearthold-kb-mage
# portal frontend changed? rebuild the Vite bundle nginx serves:
cd apps/kb-portal && VITE_PORTAL_URL=https://kb.archon.social VITE_KB_ID=hearthold-kb \
  VITE_SIGNET_URL=https://wallet.archon.technology npm run build
```

### ⚠️ Wallet-mutating Warden commands — stop the service first
Any command that creates keys/groups/DIDs in the Warden wallet (`kb-init`, `kb-grant`, `kb-govern`,
`kb-spaces enable`, `delegate`, …) writes `warden/wallet.json`. The live `warden serve` also owns that
wallet — running a second writer concurrently risks corruption. Always:
```bash
sudo systemctl stop hearthold-warden
tar czf ~/infra-backups/hearthold-warden/hearthold-warden-PRE-<change>-$(date +%Y%m%d-%H%M%S).tgz \
  -C ~/.hearthold-warden warden                 # back up before mutating
set -a; . /opt/hearthold/.env.warden; set +a
node packages/warden/dist/index.js <command>    # e.g. kb-spaces enable --default-scope shared --kb hearthold-kb
node packages/warden/dist/index.js kb-status     # verify
sudo systemctl start hearthold-warden
```

### Health check
```bash
systemctl is-active hearthold-warden hearthold-kb-mage
journalctl -u hearthold-warden -f     # expect "Warden serving …"; a portal login logs "login-start received → challenge issued"
curl -s https://kb.archon.social/ | head
```

### Backup hygiene
- Keep backups under `~/infra-backups/` (out of the repo). They contain secrets — never `git add` them.
- `.env.warden` / `.env.kb-mage` are gitignored (0600). Never commit wallet/vault state.
