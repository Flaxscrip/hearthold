# Deploying the City of Mages Chronicles KB at mages.archon.social

**STATUS: PROVISIONED + LIVE (2026-08-24).** mages.archon.social serves a working portal +
oracle. (An earlier draft of this doc said "STAGED, NOT PROVISIONED / identities not minted";
that header was stale — the live values are in **Provisioned values** below, and the
historical staging/blocker notes are dated at the end.)

A **third** Warden + Mage pair on `archon` (74.208.222.204), independent of the personal KB
and the HATPro KB. Aegis (flaxscrip's infra session on megaflax) runs KB provisioning and
curation; this host provides the public production surface.

| | personal | hatpro | **mages (this)** |
|---|---|---|---|
| Warden unit | `hearthold-warden` | `hearthold-hatpro-warden` | `hearthold-mages-warden` |
| Mage unit | `hearthold-kb-mage` | `hearthold-hatpro-mage` | `hearthold-mages-mage` |
| Warden env | `.env.warden` | `.env.hatpro-warden` | `.env.mages-warden` |
| Mage env | `.env.kb-mage` | `.env.hatpro-mage` | `.env.mages-mage` |
| Warden data | `~/.hearthold-warden` | `~/.hearthold-hatpro-warden` | `~/.hearthold-mages-warden` |
| Mage data | `~/.hearthold-kb-mage` | `~/.hearthold-hatpro-mage` | `~/.hearthold-mages-mage` |
| Bridge port | `4313` | `4314` | **`4315`** |
| Hostname | `kb.archon.social` | `kb.hatpro.archon.technology` | **`mages.archon.social`** |
| KB id | `hearthold-kb` | `hatpro-kb` | **`city-of-mages`** |
| Posture | private | private | **PUBLIC** |

## Posture — read this before anything else

This KB is deliberately **public**: external AIs (SoulBae, anchored on Mitchell's node)
authenticate by `did:cid` challenge/response and curate as writeGroup members.

**That posture attaches to THIS Warden only.** `hearthold-warden` (personal, behind
`kb.archon.social`) stays private. "The node is public" is true of the *host's* network
stance, NOT of every vault on it. The three Wardens are isolated by data root and by systemd
`ReadWritePaths`; never widen one to reach another.

## Confirmed host posture (verified 2026-08-23)

1. **Registry = `hyperswarm`** (federated) — `["hyperswarm","BTC:mainnet","BTC:signet"]`, not
   `local`. Proven live: many DIDs in the gatekeeper DB vs 2 IDs in the wallet, so foreign
   `did:cid` cross-resolution works. Mediator healthy, 5–6 peers. **Caveat:** hyperswarm
   peering is keyed on the protocol topic `/ARCHON/v0.8-beta`; a node on a different Archon
   protocol version will NOT gossip regardless of also using "hyperswarm". Confirm a
   counterparty node joins that topic.
2. **Public web + TLS** — nginx on this host, certbot-managed, `certbot.timer` enabled. Use a
   **standalone cert lineage** for this host, not the shared 13-SAN bundle, so removal is
   clean and the shared renewal blast radius stays fixed.
3. **Public egress, not air-gapped** — 0 compose files declare `internal: true`.
4. **Public DIDComm mailbox** — `https://archon.technology/didcomm/api/v1/challenge` → 200.

## Registry posture — THREE keys, and they do NOT all inherit

Directive: everything at mages.archon.social must resolve publicly, **zero `local`**.
**`HEARTHOLD_REGISTRY=hyperswarm` alone does NOT achieve that.** Hearthold is `local`-by-
default on purpose (`packages/core/src/config.ts`: "born local, promoted never" — Archon's
reference node defaults to public hyperswarm; Hearthold does not inherit that). The three
keys resolve independently:

```
registry          = HEARTHOLD_REGISTRY           ?? 'local'
contentRegistry   = HEARTHOLD_CONTENT_REGISTRY   ?? 'local'   <-- does NOT inherit HEARTHOLD_REGISTRY
ephemeralRegistry = HEARTHOLD_EPHEMERAL_REGISTRY ?? HEARTHOLD_REGISTRY ?? 'local'
```

`contentRegistry` falling back to `local` is deliberate: "content is born `local` regardless
of the identity registry (privacy by construction + avoids the hyperswarm never-confirms
stall)." Both live Wardens run this split (identities/groups/grants gossip publicly; artefact
content stays node-local) — the working posture, not a misconfiguration.

**CORRECTED 2026-08-24 — the gatekeeper DOES reject `local`.** An earlier claim that a
`local` op never reaches the gatekeeper was wrong. Observed:
`InvalidOperationError: Invalid operation: registry local not supported` — firing at Warden
start, surfacing only as the opaque `warden: [object Object]` line (see Known defects). So on
this node `local` is not merely "private" — it is **unusable** for the CONTENT write path
(exactly what seeding does); reads/logins are unaffected.

**Set all three keys EXPLICITLY in `.env.mages-warden`** so the posture is auditable from the
file, never inferred from defaults (any unset key silently yields `local`):
```
HEARTHOLD_REGISTRY=hyperswarm
HEARTHOLD_EPHEMERAL_REGISTRY=hyperswarm
HEARTHOLD_CONTENT_REGISTRY=<hyperswarm|local>   # decision below; NEVER leave unset
```
**Content → `hyperswarm`?** Only if chronicle artefacts must resolve by DID independently of
the Warden. Documented hazard: content on hyperswarm can hit a **"never-confirms stall."** If
readers reach entries through the Warden's read/recall API (they do), `local` content is
sufficient and safer. Do not flip it blind.

## Model dependency — SETTLED

`HEARTHOLD_OLLAMA_URL=http://megaflax:11434`, `HEARTHOLD_CLASSIFIER_MODEL=qwen3:8b`. **NOT**
`HEARTHOLD_CLASSIFIER=quarantine`: the model serves *recall* (RAG) as well as classification,
so quarantining would let external AIs read raw entries but not query the chronicle — gutting
a collaboration KB. Recall embeds with `HEARTHOLD_EMBEDDING_MODEL` (default `nomic-embed-text`,
on megaflax) and answers with the chat model. megaflax is an **always-on workstation**
(confirmed 2026-08-23), a reliable dependency; a dedicated Ollama host for load isolation is
an optional upgrade, not a reliability fix.

## Provisioned values (live, 2026-08-24)

```
Warden DID   did:cid:bagaaierahiawrg6k7zztmzxmafyercspm3zyjeblm7x7ltoyg2iluxuazb3a
Mage DID     did:cid:bagaaieramxubblxj3dar3fyjuct3w6yvskwljjfbv2fctb6rrvzj5hljqgvq
readGroup    did:cid:bagaaierah7ypdiuac6s27aiiecz5ouiupxzhz4rg63ht4jhfea7uwp5cvi4q
writeGroup   did:cid:bagaaierapathybub5w3q2vpdlzbbwv55vn76iv5zvv7miabgrgtuhdwewy2a
governor     did:cid:bagaaiera7vsjlu6oiluzd4enop5j7sfzjbwp2ujudt6uunkz6hhd4lgfe4sa (flaxscrip)
curator      did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq (GenitriX)
policyAsset  did:cid:bagaaieravfso3ib5ygdqrwkiusagi25ec6pomsostxvgbk2nlzvxphatu6da
openEnrollment true · enrollGrantsPromote false · memberPartitions true · maxMembers 128
```
Both Warden and Mage DID docs carry `DIDCommMessaging → https://archon.technology/didcomm`,
verified resolving locally AND through the public universal resolver on arche1. Curators are
**known DIDs** — one explicit grant each (`warden kb-grant <did> both --kb city-of-mages`);
resolve the foreign DID on this node FIRST (a freshly minted foreign DID may not have gossiped
yet). Never wildcard.

## Portal build

```bash
cd /opt/hearthold && npm run build
cd apps/kb-portal
VITE_PORTAL_URL=https://mages.archon.social \
VITE_KB_ID=city-of-mages \
VITE_SIGNET_URL=https://wallet.archon.technology \
npm run build -- --outDir dist-mages     # nginx serves apps/kb-portal/dist-mages
```

## Install / Verify / Rollback

The vhost is **HTTP-only by design** (nginx refuses an `ssl` listener with no cert; certbot
rewrites the file in place adding 443 + redirect). Steps 1–2 are safe before the identities
exist (a neutral "being provisioned" placeholder; `/api/` 502s until the Mage is up).

```bash
# 1. HTTP-only vhost
sudo ln -sf /opt/hearthold/deploy/mages.archon.social.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# 2. cert (standalone lineage — do NOT expand the 13-SAN bundle); rewrites the vhost to add 443
sudo certbot --nginx -d mages.archon.social
# 3. Warden FIRST (mailbox drainer), then the Mage
sudo cp /opt/hearthold/deploy/hearthold-mages-warden.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hearthold-mages-warden
sudo cp /opt/hearthold/deploy/hearthold-mages-mage.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hearthold-mages-mage
```
```bash
# Verify
journalctl -u hearthold-mages-warden -f     # "Warden serving over DIDComm ... city-of-mages"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4315/
curl -s -o /dev/null -w '%{http_code}\n' https://mages.archon.social/
systemctl is-active hearthold-warden hearthold-kb-mage hearthold-hatpro-warden hearthold-hatpro-mage
curl -s -o /dev/null -w '%{http_code}\n' https://kb.archon.social/     # other KBs untouched
```
```bash
# Rollback (data roots left intact)
sudo systemctl disable --now hearthold-mages-mage hearthold-mages-warden
sudo rm /etc/nginx/sites-enabled/mages.archon.social.conf && sudo systemctl reload nginx
```

## Known defects surfaced during provisioning (tracked as issues; fixes not in this doc)

1. **`recall.ts` has no timeout.** `OllamaEmbedder.embed()` and `ollamaAnswerer()` call Ollama
   with bare `fetch` — no `signal`, no `AbortSignal.timeout`, no try/catch — while
   `classifier.ts` beside them fails safe. A stalled Ollama host (a Tailscale blip, a model
   reload, an `ollama` restart — sleep NOT required) makes a query **hang**: measured >25s
   with no app timeout, and nginx `/api/` `proxy_read_timeout` is 210s, so an external AI
   waits up to ~3.5 min for a 504 instead of a fast, honest error. Recommended:
   `AbortSignal.timeout(10_000)` on embeddings, `120_000` on chat, catch → "recall temporarily
   unavailable". Not a go-live blocker (writes + classification unaffected).
2. **Opaque startup error.** The Warden logs `warden: [object Object]` — a bad
   error-formatting path that hid the `local`-rejection above. Worth a fix so a five-minute
   diagnosis doesn't become a two-day one.
3. **Drawbridge/Gatekeeper route split.** No single `HEARTHOLD_NODE_URL` serves both
   `/api/v1/didcomm-endpoint` (Drawbridge :4222 → 200; Gatekeeper :4224 → 404) and
   `/api/v1/events/process` (:4222 → 404; :4224 → 200, needs admin key). `transport.ts
   publishTo()` calls `processEvents()` on a queuing registry (hyperswarm), which 404s through
   Drawbridge. **Dormant** now — `ready()` early-returns once an endpoint is published, and all
   five live identities already advertise theirs, so the pending HATPro restart onto main will
   NOT hit it — but it recurs on any re-home/republish. Durable fix if it does:
   `HEARTHOLD_NODE_URL=…:4224` + `HEARTHOLD_DIDCOMM_ENDPOINT=…/didcomm` + the admin key.

---

## Historical record (dated — NOT current state)

Kept so the provisioning decisions are traceable; superseded by the live state above.

- **"STAGED, NOT PROVISIONED" (2026-08-23).** The original header. Superseded 2026-08-24 by
  the live provisioning above.
- **BLOCKER: checkout upgrade (2026-08-23).** At the time `/opt/hearthold` was on
  `fix/kb-scope-stale-relay` (PR #4, 184 commits behind main), and `origin/main` already
  contained the City of Mages feature, so provisioning needed a pull + rebuild first. The
  checkout has since moved to `main`. **The still-relevant lesson:** the personal, HATPro, and
  mages Wardens all run from this one `/opt/hearthold` `dist/`, so any pull + rebuild
  **upgrades all live KBs at once** — it is never an isolated deploy; it needs a maintenance
  window and post-restart verification of every KB. (This is the exact coupling behind the
  reconcile-drift-first decision; see `deploy/INSTALL-multi-kb.md`.)
- **megaflax "sleeps" (withdrawn).** An earlier concern that megaflax was a sleeping laptop was
  based on a stale claim in INSTALL-hatpro.md; withdrawn — megaflax is always-on.
- **Curator minting plan (proposed 2026-08-23).** Aegis mints the curator DID (key control
  follows the curator), running a local Keymaster pointed at a remote Gatekeeper
  (`ARCHON_KEYMASTER_GATEKEEPER_URL`); pointing it at this node writes the DID into our DB at
  creation, so it resolves here immediately with no gossip race. (megaflax has no local
  gatekeeper and is not a hyperswarm peer of this node.) The curator DID is now provisioned
  (see live values).
