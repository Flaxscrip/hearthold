# Deploying the Hearthold Knowledge Portal at kb.archon.social

Public **Mage** (`witness kb-web`) + static portal on this server (`archon`, 74.208.222.204),
relaying over DIDComm to the KB **Warden** on flaxlap. Ollama (qwen3:8b) lives on megaflax.

## Prereqs (before the sudo steps)
1. **DNS:** `kb.archon.social` A record → `74.208.222.204` (this server). Wait for it to resolve.
2. **flaxlap Warden up:** fresh identities, `warden kb-init hearthold-kb`, `kb-seed`, `warden serve`,
   with `HEARTHOLD_NODE_URL=http://archon:4222` and `HEARTHOLD_OLLAMA_URL=http://megaflax:11434`.
   Copy the Warden `did:cid`.
3. Put the Warden DID into the Mage env file:
   `HEARTHOLD_WARDEN_DID=<wardenDid>` in `/opt/hearthold/.env.kb-mage` (uncomment the line).

## Install (sudo)
```bash
# nginx vhost
sudo cp /opt/hearthold/deploy/kb.archon.social.conf /etc/nginx/sites-available/kb.archon.social.conf
sudo ln -sf /etc/nginx/sites-available/kb.archon.social.conf /etc/nginx/sites-enabled/kb.archon.social.conf
sudo nginx -t && sudo systemctl reload nginx

# TLS (needs DNS resolving first)
sudo certbot --nginx -d kb.archon.social

# Mage service
sudo cp /opt/hearthold/deploy/hearthold-kb-mage.service /etc/systemd/system/hearthold-kb-mage.service
sudo systemctl daemon-reload
sudo systemctl enable --now hearthold-kb-mage.service
sudo systemctl status hearthold-kb-mage.service --no-pager
```

## Verify
```bash
journalctl -u hearthold-kb-mage -f          # watch the Mage; expect "KB Portal … relaying to Warden …"
curl -s https://kb.archon.social/ | head    # portal HTML
# then open https://kb.archon.social in a browser → a QR sign-in should render
```

## Rollback
```bash
sudo systemctl disable --now hearthold-kb-mage.service
sudo rm /etc/nginx/sites-enabled/kb.archon.social.conf && sudo systemctl reload nginx
```

## Rebuild the portal after a code change
```bash
cd /opt/hearthold && npm run build
cd apps/kb-portal && VITE_PORTAL_URL=https://kb.archon.social VITE_KB_ID=hearthold-kb \
  VITE_SIGNET_URL=https://wallet.archon.technology npm run build
sudo systemctl restart hearthold-kb-mage    # only if the witness/core code changed
```

## Facts
- Mage (Witness) DID: `did:cid:bagaaieraqx7wjhmovfw4l4vi4wpwp2tgtbveefryslgldf2lugpfiuiex3ga`
- Mage data root: `/home/flaxscrip/.hearthold-kb-mage`  ·  secrets: `/opt/hearthold/.env.kb-mage` (0600)
- KB id: `hearthold-kb`  ·  Mage bridge: `127.0.0.1:4313` (loopback only)
