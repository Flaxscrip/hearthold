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

> ⚠️ **Verify every archive before you rely on it — `tar czf` succeeding proves nothing.** Run
> `tar tzf <archive>` and confirm `warden/vault.json` is in the list. Both failures seen so far were
> silent: on 2026-07-15 an ad-hoc backup archived the wallet, index, KB config and partitions but
> **not the vault**, and a sibling invocation lost its `$(date …)` expansion and landed as a literal
> `%` in the filename. Neither errored; the vault survived only because the malformed one happened to
> contain it. A backup that silently lacks the vault is worse than none — it reads as protection you
> do not have.

| What | Location |
|------|----------|
| Warden data root (wallet + vault + KB config + partitions), pre-KB-Spaces | `~/infra-backups/hearthold-warden/hearthold-warden-PRE-kbspaces-20260713-204144.tgz` |
| Warden data root, last state holding the pre-reset KB content (see 2026-07-15 change log) | `~/infra-backups/hearthold-warden/hearthold-warden-VAULT-55-artefacts-20260715-202857.tgz` |
| Warden data root, immediately before the 2026-07-15 clean reset (verified complete) | `~/infra-backups/hearthold-warden/hearthold-warden-PRE-cleanreset-20260715-210736.tgz` |
| `archon.technology` nginx vhost, pre/post rate-limit bump + note | `~/infra-backups/nginx/archon.technology.conf.{PRE,POST}-ratelimit-20260713-203110`, `README-20260713-203110.txt` |

---

## Change log (newest first)

### 2026-07-15 — Clean reset of `hearthold-kb`; default scope → private; `kb-reset` found to skip private partitions
- **What**: cleared the KB's content and made the scope-less default fail safe —
  `warden kb-reset --kb hearthold-kb`, then
  `warden kb-spaces enable --default-scope private --kb hearthold-kb`. Members, both access groups,
  the policy asset, and all 5 member partition records were preserved; content only was removed.
- **Why `private`**: with `defaultScope: shared` (set 2026-07-13, below), a contribution that arrives
  without an explicit `scope` lands in the **shared** partition. The 2026-07-14 fix closed that from the
  wire side; setting the default to `private` also makes the scope-less case fail *safe* rather than
  over-share, per the deny-by-default ladder in `docs/security-model.md`. The trade-off: a scope-less
  contribution is now invisible to other members rather than over-shared. The portal sends `scope`
  explicitly, so this only governs misbehaving or outdated clients.
- **🐞 Bug found mid-operation — `kb-reset` under-deleted silently.** It filtered on
  `metadata.kb === kbId`, which matches only the shared partition, so it cleared shared content, left
  **every member private partition intact**, and still reported success. `kb-reindex --kb <id>` had the
  same blind spot (private content whose embed dropped could never be backfilled, leaving it
  permanently unsearchable to its own owner). Fixed in PR #1 (`fix/kb-reset-private-partitions`); the
  reset above was completed with the fixed build and verified to zero the vault and index.
  **If you ran `kb-reset` before that fix landed, it did not clear private partitions — re-run it.**
- **Data**: the pre-reset content was deliberately not carried forward; the last state holding it is the
  archive listed under Backups. Retained rather than deleted, in case that call is revisited.
- **Procedure**: service stopped first; backup taken **and verified to contain `warden/vault.json`**
  before mutating (see the runbook — this step is new, and is why the reset was safe to run).

### 2026-07-14 — Fix: private KB contributions were silently landing in the SHARED partition
- **Symptom**: a portal **Contribute → Private** write showed "✓ saved to your private notes" but the
  artefact was readable by anyone with shared read; its citation was tagged `scope:"shared"`.
- **Root cause — deployment staleness, NOT a code bug.** All source/`dist` correctly plumbed the KB
  Spaces `scope` field end-to-end. But `hearthold-kb-mage` (the Emissary relay) had started
  **2026-07-13 19:45:40**, and the scope-forwarding build landed **19:51:00** — after process start.
  The Warden was later restarted (21:38, current) but the kb-mage was **never restarted**, so for ~27h
  the relay ran pre-`scope` code and dropped the field. The Warden then applied `defaultScope` (`shared`)
  to every contribution. Diagnosed from `~/.hearthold-warden/warden`: all 55 index entries tagged
  `hearthold-kb`, zero in any `::priv:` partition — including owner `flaxscrip`'s intended-private test
  note `99d38f3f…` (contributor DID owns `hearthold-kb::priv:d0746da7a089d9ac`, yet the write went shared).
- **Immediate fix**: `sudo systemctl restart hearthold-kb-mage` (loads the current, scope-forwarding
  build). The KB DB was wiped + reseeded fresh (pre-announce, no other users) since existing private
  content was mis-partitioned.
- **Durable fix (defense in depth)**: the `kb-result` `update` message now carries an authoritative
  `scope` echo from the Warden; the portal renders its success/warn message from *that*, never from the
  button the user clicked — so a dropped scope surfaces as a loud mismatch, never a false success.
  Regression coverage added in `scripts/e2e-kb-spaces.ts` (asserts the update RESULT's `scope`).
- **Runbook fix**: the wallet-mutating procedure now flags that a core/Emissary rebuild requires a
  `kb-mage` restart (see below).

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
sudo systemctl stop hearthold-warden            # stop FIRST: a stopped service gives a consistent snapshot

# Back up, then prove the backup is real. Quote "$BK" and keep the whole `warden` dir in one -C:
# hand-listing files is how the vault got left out on 2026-07-15.
BK=~/infra-backups/hearthold-warden/hearthold-warden-PRE-<change>-$(date +%Y%m%d-%H%M%S).tgz
tar czf "$BK" -C ~/.hearthold-warden warden
tar tzf "$BK"                                   # eyeball the list — expect wallet/vault/index/kb/partitions
for f in warden/wallet.json warden/vault.json warden/index.json; do
  tar tzf "$BK" | grep -qx "$f" || echo "⚠ BACKUP INCOMPLETE: $f missing — STOP, do not mutate"
done
case "$BK" in *%*) echo "⚠ FILENAME HAS A LITERAL % — the date expansion was eaten; rename before relying on it";; esac

set -a; . /opt/hearthold/.env.warden; set +a
node packages/warden/dist/index.js <command>    # e.g. kb-spaces enable --default-scope shared --kb hearthold-kb
node packages/warden/dist/index.js kb-status     # verify
sudo systemctl start hearthold-warden
```
> ⚠️ **If the release you just built also changed `@hearthold/core` or the Emissary** (e.g. a new wire
> field like `scope`), restart the Emissary too — it does **not** hot-reload:
> ```bash
> sudo systemctl restart hearthold-kb-mage
> ```
> A long-running `kb-mage` keeps executing the JS it loaded at *process start*; a `dist/` rebuilt
> underneath it has no effect until restart. This procedure only cycles the Warden, so the two ends can
> silently diverge on the protocol — which is exactly how the KB-Spaces `scope` field was dropped by the
> relay for ~27h while the Warden and browser both understood it (see change log 2026-07-14).

### Health check
```bash
systemctl is-active hearthold-warden hearthold-kb-mage
journalctl -u hearthold-warden -f     # expect "Warden serving …"; a portal login logs "login-start received → challenge issued"
curl -s https://kb.archon.social/ | head
```

### Backup hygiene
- Keep backups under `~/infra-backups/` (out of the repo). They contain secrets — never `git add` them.
- `.env.warden` / `.env.kb-mage` are gitignored (0600). Never commit wallet/vault state.
