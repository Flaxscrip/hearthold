# Deploying the Hearthold Knowledge Portal at kb.archon.social

Static portal + public **Emissary** (`emissary kb-web`) **and** the KB **Warden** (`warden serve`),
all co-located on this server (`archon`, 74.208.222.204). The only remaining off-box dependency is
**megaflax** for the on-device classifier (Ollama, qwen3:8b @ `http://megaflax:11434`).

Two systemd units, both under user `flaxscrip`, both reaching the local Archon node (Drawbridge on
`localhost:4222`) over DIDComm — they address each other by `did:cid`, not by URL:

| Unit | Role | Data root | Env file |
|------|------|-----------|----------|
| `hearthold-warden.service` | custodian: holds the vault + `hearthold-kb`, drains its mailbox, serves evidence | `~/.hearthold-warden` | `/opt/hearthold/.env.warden` |
| `hearthold-kb-mage.service` | world-facing Emissary; HTTP↔DIDComm bridge on `127.0.0.1:4313` behind nginx TLS | `~/.hearthold-kb-mage` | `/opt/hearthold/.env.kb-mage` |

> **History:** the Warden formerly ran on **flaxlap**; its vault was migrated to `~/.hearthold-warden`
> here. The Warden `did:cid` is anchored on the archon node, so the move is transparent — the Emissary
> already addresses `…r4tt4od…` and needs no reconfig. **After cutover, stop `warden serve` on flaxlap**
> so two processes don't drain the same mailbox (split-brain would diverge the vaults).

## Prereqs (before the sudo steps)
1. **DNS:** `kb.archon.social` A record → `74.208.222.204` (this server). Wait for it to resolve.
2. **Warden data present:** `~/.hearthold-warden/warden/` holds the migrated `wallet.json`, `vault.json`,
   `index.json`, and `hearthold-kb.json`. Confirm identity + KB:
   ```bash
   set -a; . /opt/hearthold/.env.warden; set +a
   node packages/warden/dist/index.js status      # → did:cid:…r4tt4od… , artefacts: 47
   node packages/warden/dist/index.js kb-status    # → Knowledge Base "hearthold-kb", 5 members
   ```
3. **megaflax reachable:** `curl -s http://megaflax:11434/api/tags` lists `qwen3:8b`.
4. The Emissary env already points at this Warden (`HEARTHOLD_WARDEN_DID=did:cid:…r4tt4od…` in
   `/opt/hearthold/.env.kb-mage`) — no change needed since the DID was preserved through the migration.

## Install (sudo)
```bash
# nginx vhost
sudo cp /opt/hearthold/deploy/kb.archon.social.conf /etc/nginx/sites-available/kb.archon.social.conf
sudo ln -sf /etc/nginx/sites-available/kb.archon.social.conf /etc/nginx/sites-enabled/kb.archon.social.conf
sudo nginx -t && sudo systemctl reload nginx

# TLS (needs DNS resolving first)
sudo certbot --nginx -d kb.archon.social

# Warden service (custodian + vault) — install & start FIRST so the mailbox has a drainer
sudo cp /opt/hearthold/deploy/hearthold-warden.service /etc/systemd/system/hearthold-warden.service
sudo systemctl daemon-reload
sudo systemctl enable --now hearthold-warden.service
sudo systemctl status hearthold-warden.service --no-pager

# Emissary service (world-facing bridge)
sudo cp /opt/hearthold/deploy/hearthold-kb-mage.service /etc/systemd/system/hearthold-kb-mage.service
sudo systemctl daemon-reload
sudo systemctl enable --now hearthold-kb-mage.service
sudo systemctl status hearthold-kb-mage.service --no-pager
```

## Verify
```bash
journalctl -u hearthold-warden -f           # expect "Warden serving over DIDComm … serving … hearthold-kb"
journalctl -u hearthold-kb-mage -f          # watch the Emissary; expect "KB Portal … relaying to Warden …"
curl -s https://kb.archon.social/ | head    # portal HTML
# a portal login round-trip should surface in the WARDEN log as:
#   [kb] login-start received (kb=hearthold-kb) …  →  [kb] → challenge issued
# then open https://kb.archon.social in a browser → a QR sign-in should render
```

## Rollback
```bash
sudo systemctl disable --now hearthold-kb-mage.service
sudo systemctl disable --now hearthold-warden.service
sudo rm /etc/nginx/sites-enabled/kb.archon.social.conf && sudo systemctl reload nginx
```

## Rebuild the portal after a code change
```bash
cd /opt/hearthold && npm run build
cd apps/kb-portal && VITE_PORTAL_URL=https://kb.archon.social VITE_KB_ID=hearthold-kb \
  VITE_SIGNET_URL=https://wallet.archon.technology npm run build
sudo systemctl restart hearthold-kb-mage    # only if the emissary/core code changed
```

## Facts
- Warden DID: `did:cid:bagaaierar4tt4odssk62e66473baajrosuehbueehj6mxnl5xvpykmpzd4ja`
- Warden data root: `/home/flaxscrip/.hearthold-warden`  ·  secrets: `/opt/hearthold/.env.warden` (0600)
- Emissary DID: `did:cid:bagaaieraqx7wjhmovfw4l4vi4wpwp2tgtbveefryslgldf2lugpfiuiex3ga`
- Emissary data root: `/home/flaxscrip/.hearthold-kb-mage`  ·  secrets: `/opt/hearthold/.env.kb-mage` (0600)
- KB id: `hearthold-kb` (5 members)  ·  Emissary bridge: `127.0.0.1:4313` (loopback only)
- Node: Archon Drawbridge `localhost:4222`  ·  Classifier: Ollama `qwen3:8b` @ `http://megaflax:11434`
