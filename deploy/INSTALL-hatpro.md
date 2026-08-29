# Deploying a second Hearthold Knowledge Portal at kb.hatpro.archon.technology

A **separate** Warden + Mage pair for HATPro, so hotel-visitor submissions from
`apps/traveler-wallet` never land in flaxscrip's personal `hearthold-kb` vault. Same
box (`archon`, 74.208.222.204), same proven pattern as `deploy/INSTALL.md`, different
identities / data roots / port / hostname.

Provisioned 2026-08-17.

| | personal KB (existing) | **HATPro KB (this)** |
|---|---|---|
| Warden unit | `hearthold-warden.service` | `hearthold-hatpro-warden.service` |
| Mage unit | `hearthold-kb-mage.service` | `hearthold-hatpro-mage.service` |
| Warden env | `.env.warden` | `.env.hatpro-warden` |
| Mage env | `.env.kb-mage` | `.env.hatpro-mage` |
| Warden data root | `~/.hearthold-warden` | `~/.hearthold-hatpro-warden` |
| Mage data root | `~/.hearthold-kb-mage` | `~/.hearthold-hatpro-mage` |
| Bridge port | `127.0.0.1:4313` | `127.0.0.1:4314` |
| Hostname | `kb.archon.social` | `kb.hatpro.archon.technology` |
| KB id | `hearthold-kb` | `hatpro-kb` |

## Identities (already minted — do NOT re-run `init`)

```
Warden    did:cid:bagaaierabrngombpdqcno25n7ufg5q6h37fdnv5lr5rwiv3buqdkcc3sdooq
Mage      did:cid:bagaaieragfoxcyk4lxtaejvwwdzavc52vl5oyzljwnc4xobmndocn4akmqbq
delegation credential  did:cid:bagaaieraqykb35vyxgwjzq6fcntitsciwv36qiffouswvorg4kuhxq5cwuga  (issued + accepted)
```

KB `hatpro-kb` is provisioned, **self-governed**, with **per-member private partitions
enabled** (`--default-scope private`) — scope-less contributions land in the submitting
member's own partition, which is what traveler-wallet's profile dual-write needs.

Read/write groups and policy:
```
read group   did:cid:bagaaierafwgayetb2xavqnaxgsieqnmlntgvzhxjkz2uxg5lozs4jalqjzia
write group  did:cid:bagaaierah6qqz4y6ql2idkjszfdzrwuziy7rgpt3vou5w4kwlxicyvmbiskq
policy       did:cid:bagaaierahcuabd5ngkjdtucwg7q5eapnkkot7gy3omxqjuuvrero35rhmpfq
assurance    read -> factor1 · write -> factor1
```

The Warden passphrase was generated with `openssl rand -base64 36`, written directly
into `.env.hatpro-warden` (0600) and **never printed to a terminal or transcript**.
Copy it into a password manager from that file — losing it loses the Warden wallet and
therefore the KB identity.

## Prereqs (before the sudo steps)

1. **DNS:** `kb.hatpro.archon.technology` A record -> `74.208.222.204`. Wait for it to
   resolve *before* running certbot.
2. **Portal build.** The SPA must be built with this KB's id into a separate dist so it
   does not collide with the personal portal:
   ```bash
   cd /opt/hearthold && npm run build
   cd apps/kb-portal
   VITE_PORTAL_URL=https://kb.hatpro.archon.technology \
   VITE_KB_ID=hatpro-kb \
   VITE_SIGNET_URL=https://wallet.archon.technology \
   npm run build -- --outDir dist-hatpro
   ```
   The nginx vhost serves `apps/kb-portal/dist-hatpro`.
3. **megaflax reachable** for the classifier: `curl -s http://megaflax:11434/api/tags`
   lists `qwen3:8b`. megaflax is an **always-on workstation** (see the corrected "Known
   dependency" note below — it is NOT a laptop that sleeps), so this is a reliable
   dependency, not an intermittent one.

## Install (sudo)

```bash
# nginx vhost (file already written to sites-available)
sudo ln -sf /etc/nginx/sites-available/kb.hatpro.archon.technology.conf \
            /etc/nginx/sites-enabled/kb.hatpro.archon.technology.conf
sudo nginx -t && sudo systemctl reload nginx

# TLS (DNS must resolve first)
sudo certbot --nginx -d kb.hatpro.archon.technology

# Warden FIRST so the mailbox has a drainer
sudo cp /opt/hearthold/deploy/hearthold-hatpro-warden.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hearthold-hatpro-warden.service
sudo systemctl status hearthold-hatpro-warden.service --no-pager

# Then the world-facing Mage
sudo cp /opt/hearthold/deploy/hearthold-hatpro-mage.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hearthold-hatpro-mage.service
sudo systemctl status hearthold-hatpro-mage.service --no-pager
```

## Verify

```bash
journalctl -u hearthold-hatpro-warden -f    # expect "Warden serving over DIDComm … hatpro-kb"
journalctl -u hearthold-hatpro-mage   -f    # expect "KB Portal … relaying to Warden …"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4314/   # bridge is up
curl -s https://kb.hatpro.archon.technology/ | head               # portal HTML
# confirm the personal KB is untouched:
systemctl is-active hearthold-warden hearthold-kb-mage
curl -s -o /dev/null -w '%{http_code}\n' https://kb.archon.social/
```

## OPEN ITEM — traveler authorization (HATPro side, not resolved here)

`hatpro-kb` currently has **0 members**. Authorization is group membership:
```bash
warden kb-grant <sovereignDid> both --kb hatpro-kb    # provisions that member's private partition
```
HATPro travelers are arbitrary members of the public who self-onboard, so *something*
must grant each new traveler DID write access at onboarding time — plausibly the
existing `hatpro-issuer-api` (which already auto-issues a verified credential on
traveler onboarding). **Until that exists, traveler-wallet's KB dual-write will be
rejected for every visitor** — the app degrades gracefully, but the feature is inert.
This needs a decision from the HATPro side; do not paper over it by granting a wildcard.

## Known dependency

The Warden classifies artefact sensitivity on-device at `http://megaflax:11434`
(Ollama, `qwen3:8b`).

**CORRECTED 2026-08-23:** an earlier version of this note claimed megaflax "is a macOS
laptop and sleeps", making the dependency intermittent. That was wrong — flaxscrip
confirms megaflax is an **always-on workstation**. The pointer is a reliable dependency.
The stale claim propagated into later planning and caused real faults to be dismissed as
benign; if you see it repeated elsewhere, it is this note's fault.

Real caveat that does still apply (see INSTALL-mages.md): the *recall* path has no
client-side timeout, so any transient stall on the Ollama host hangs the query rather
than failing fast. Classification is unaffected — it fails safe to SEALED.

## Rollback

```bash
sudo systemctl disable --now hearthold-hatpro-mage.service
sudo systemctl disable --now hearthold-hatpro-warden.service
sudo rm /etc/nginx/sites-enabled/kb.hatpro.archon.technology.conf
sudo systemctl reload nginx
```
Data roots (`~/.hearthold-hatpro-*`) are left intact by rollback — remove them only if
you intend to discard the KB identity permanently.
