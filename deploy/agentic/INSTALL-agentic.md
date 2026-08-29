# Deploying the agency book KB at agentic.archon.technology (T3 — flaxlap-served)

David's *Architecture of Agency* corpus (9 volumes, ~1363 passages) as a **member-gated** KB: only the owner
and David (once granted) query it, behind the challenge/response wall. Public URL
`agentic.archon.technology`, **served from flaxlap**, fronted by archon-ops's nginx over the tailnet.

> **Chosen topology: T3.** After joint diligence (Hearthold + Aegis + archon-ops), flaxlap won over both the
> archon.technology host and a megaflax+doorman shape. Why: flaxlap has **both `local` and `BTC:mainnet`**, so
> the access-control objects are born `local` (no gossip, no confirm-stall) **and** David's mainnet identity
> resolves for his grant + login — standard `kb-web` member login, **no doorman**. It **isolates** David's KB
> on its own host (zero coupling to the shared /opt/hearthold tree that carries HATPro/NIH). And measured, it
> is the more available host (25-day-stable Linux server; its Archon stack self-recovers after reboot).

## Topology

```
David ──HTTPS──▶ agentic.archon.technology
                   │  (archon-ops) nginx + standalone TLS, deferred-resolution proxy_pass
                   ▼  over the tailnet
                 flaxlap  ── kb-web Mage (member login) ──DIDComm──▶ agency Warden (custodian, holds vault.json)
                                                                        registry: local
                   answer generation ──tailnet──▶ megaflax:11434 (host Ollama, qwen3:8b — LaunchAgent)
```

- **Identity, login, and the sealed corpus live entirely on flaxlap** and stay up independently of megaflax.
- **Only answer generation crosses the tailnet** to `megaflax:11434` (flaxlap's 2 GB GPU can't host the model).
  megaflax's Ollama is a LaunchAgent (`RunAtLoad` + `KeepAlive`), so it self-recovers after a reboot — unlike
  Docker on that box. So the availability story is **flaxlap AND megaflax's Ollama**, honestly stated.

## Prereqs (verified during scoping)

- **flaxlap resolves David's real mainnet DID** — `did:cid:bagaaierar7rd7vkb5aq4ie4wzdlfpcxthvsi6q4uspn6zopy5amthleslyza`
  (`.well-known` name `cypher@4tress.org`), confirmed v7, verification key present. megaflax returns `200` but
  `notFound` in the body — **read the body, not the status** (this is the #54 trap).
- **flaxlap has `local` + `BTC:mainnet`** in `ARCHON_GATEKEEPER_REGISTRIES` (`["hyperswarm","BTC:mainnet","BTC:signet","ETH:mainnet","SOL:mainnet-beta","local"]`).
  The cross-registry mechanic (a `local` group granting + authenticating a member on a non-local registry) is
  proven end-to-end — `scripts/e2e-xreg-login.ts`.
- **megaflax:11434** reachable from flaxlap over the tailnet with `qwen3:8b` + `nomic-embed-text` resident.
- **`#60` merged** — the born-in-git baseline. flaxlap starts clean: everything below is committed, not host-only.

## Restart policies (do this first — the one real fragility we found)

flaxlap's single observed outage was a container with **`RestartPolicy: no`** (bitcoin-core), which stayed down
until a human noticed. Before hosting David's KB:
- Set `restart: unless-stopped` on `bitcoin-core-1` (and audit flaxlap for anything else with no restart policy).
- The agency systemd units below carry `Restart=on-failure` + `RestartSec` from the start.

## Step 1 — build the corpus ON flaxlap (a rebuild, not a copy)

The corpus is **sealed to the Warden's key** (`sealForWarden` → `encryptMessage`), so megaflax's `vault.json`
cannot be copied here — it must be **rebuilt** on flaxlap (~minutes; the 1363 passages are local sealed files,
not registry writes, so there is no seed-to-hyperswarm and no stall). Owner-only for now; David's grant is Step 2.

```sh
# on flaxlap, in the repo checkout, with the 0600 env file loaded:
HEARTHOLD_REGISTRY=local \
HEARTHOLD_NODE_URL=http://localhost:4222 \
HEARTHOLD_OLLAMA_URL=http://megaflax:11434 \
HEARTHOLD_ANSWER_MODEL=qwen3:8b \
HEARTHOLD_DATA_ROOT=<flaxlap agency data root> \
HEARTHOLD_PASSPHRASE=<0600 secret> \
AGENCY_DAVID=none \
npm run build:agency-kb
# copy the printed Warden DID → the Mage's HEARTHOLD_WARDEN_DID.
```

## Step 2 — David's grant (flaxscrip's DIRECT instruction to Aegis) + POSITIVE verification

> This grants read on a real person's mainnet DID. It is **flaxscrip's direct instruction to Aegis**, never
> relayed through an assistant. It runs on flaxlap, which resolves BTC:mainnet.

Re-run the grant with David's DID (or `AGENCY_DAVID=did:cid:bagaaierar7rd…`), then **verify positively — never
infer from a clean exit code** (deny-by-default makes "failed" and "healthy" look identical from outside):

```sh
# 1. membership:
warden kb-status --kb agency            # David's DID present in the read group
# 2. a REAL login end to end: challenge → David's wallet responds → session → a query returns an answer.
```

## Step 3 — serve on flaxlap (Warden + member-login Mage; NO oracle)

Member-gated: the `kb-web` Mage runs **without** an oracle reader (no anonymous ask). Install the two systemd
units in this directory (`hearthold-agentic-{warden,mage}.service`) — **reconcile the flaxlap-specific paths
first** (node binary, repo dir, data root; Aegis provides these). Warden first (mailbox drainer), then the Mage.

## Step 4 — front it (archon-ops)

`agentic.archon.technology` → nginx → flaxlap over the tailnet, using the **deferred-resolution** pattern
(`set $var` + `resolver`), **never a literal upstream hostname** (a literal resolves at nginx startup and is
fatal to every vhost on the box, HATPro included). **Standalone cert lineage**, not the shared 13-SAN bundle.
Build the portal SPA for this KB:

```sh
cd apps/kb-portal
VITE_PORTAL_URL=https://agentic.archon.technology \
VITE_KB_ID=agency \
VITE_SIGNET_URL=https://wallet.archon.technology \
npm run build -- --outDir dist-agentic
```

---

## ⛔ SAFETY RAIL — NEVER run `warden rotate` on the agency Warden

**Rotating the Warden's keys silently orphans the entire sealed corpus.** `unsealAsWarden` uses the *current*
id keypair with no fallback to prior keys, so after a rotate every one of the 1363 passages fails to decrypt
(`aes/gcm: invalid ghash tag`) — while the CLI reports **success**. Its exact message is the thing that will
mislead an operator (quoted verbatim so it's recognisable):

> `rotated the current identity's signing keys (existing DIDs keep resolving; the old key can no longer sign)`

It names *signing*, reassures that DIDs resolve, and says **nothing about sealed data**. The corpus is gone and
the tool sounds fine. (Verified in a sandbox: 13/13 readable → 0/13 after rotate.)

**If it happens anyway — the recovery, tested (do NOT restore from backup, do NOT rotate again):**
Revert the DID document's `verificationMethod` to the **prior** key, signing the update with the **current
(post-rotation)** wallet — `updateDID`. `fetchKeyPair` then walks indices down, matches the prior key, and
every passage opens again. Verified recovery: **0/13 → 13/13**.

Why not "restore from backup"? A file backup does **not** undo a rotation — the rotation lives in the DID
*document* (on the node), not in any file. Restoring `vault.json` alone fails (`invalid ghash tag`); restoring
`wallet.json` + `vault.json` fails differently (`no current-id keypair`, because `fetchKeyPair` matches the
wallet against the on-node document). Restoring is the instinctive wrong move that muddies the state you need.

## Backup — for DISK LOSS, not rotation

A backup protects the corpus against **losing the machine/disk**, a different failure mode from rotation. The
backup **unit** is all of these **together** — `vault.json` alone is unopenable ciphertext:

```
wallet.json  +  its passphrase  +  vault.json  +  index.json
```

Store it off-flaxlap (David's sealed corpus should not have its only copy on one machine). It does **not** and
cannot protect against a key rotation (see the rail above).

## Born-in-git

Everything here — the units, this runbook, the SPA build recipe, the nginx vhost — lands in the repo **before**
it touches flaxlap. flaxlap's `.env.*` (0600 secrets) and its built `dist-agentic/` stay host-only by design;
nothing else does. Carry the #60 lesson to the new host: no host-only drift from day one.
