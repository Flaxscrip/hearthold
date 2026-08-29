# Deploying the agency book KB at agentic.archon.technology (T3 — flaxlap-served)

David's *Architecture of Agency* corpus (9 volumes, ~1363 passages) as a **member-gated** KB: only the owner
and David (once granted) query it, behind the challenge/response wall. Public URL
`agentic.archon.technology`, **served from flaxlap**, fronted by archon-ops's nginx over the tailnet.

> **Chosen topology: T3.** After joint diligence (Hearthold + Aegis + archon-ops), flaxlap won over both the
> archon.technology host and a megaflax+doorman shape. Why: flaxlap has **both `local` and `BTC:mainnet`**, so
> the access-control objects are born `local` (no gossip, no confirm-stall) **and** David's mainnet identity
> resolves for his grant + login — standard `kb-web` member login, **no doorman**. It **isolates** David's KB
> on its own host (zero coupling to the shared /opt/hearthold tree that carries HATPro/NIH). It is a
> 25-day-stable Linux server — **but its Archon stack does NOT auto-recover after a reboot** (all 32 containers
> are `RestartPolicy: no`, corrected from an earlier wrong claim). That is a **fixable config gap** — unlike
> megaflax, whose macOS blocks Docker autostart entirely — and it is a **hard pre-go-live condition** below.

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
- **flaxlap's checkout must be updated FIRST.** `~/hearthold` on flaxlap is **319 commits behind main**
  (`build-agency-kb.ts` is absent; the classifier runaway fix #61 is absent — the corpus build would stall
  20 min/passage without it). Before Step 1: `cd ~/hearthold && git pull origin main && npm ci && npm run build`.
- **Disk:** flaxlap's root fs is ~90% full (48 G free). The corpus is ~32 MB (fits trivially), but the 90% is
  worth attention independently.

## Restart policies — a HARD pre-go-live condition (corrected: it's the whole stack)

**Correction:** an earlier claim that flaxlap's Archon stack self-recovers after reboot was wrong. Measured:
**all 32 containers are `RestartPolicy: no`**, and only `docker.service`/`docker.socket` are enabled systemd
units (no `@reboot` cron). So after a reboot flaxlap stays down until a person runs `docker compose up` — the
**same outcome as megaflax**, not better. The difference that still favours flaxlap: this is a **fixable config
gap**, whereas megaflax's is an OS restriction we can't fix. **Closing it is a hard condition before go-live**,
for the whole Archon stack (gatekeeper, drawbridge, mongodb, didcomm, the mediators), not just `bitcoin-core`.

**But NOT via a `docker update --restart` sweep** — flaxlap's resolved compose already carries **77
`depends_on`/`service_healthy`/`healthcheck` conditions** (in the `include:`d graph, invisible in the top-level
file). A per-container restart policy discards all of them: Docker's restart has no notion of order or
readiness, so it fires everything at once and a Warden can come up into a not-yet-ready gatekeeper. It is also
imperative host mutation — the next `docker compose up` silently reverts it to `no`, failing born-in-git. Do
this instead, both recorded in git:
1. **`restart: unless-stopped` in the compose files** (not `docker update`) — survives daemon restarts.
2. **A boot-time systemd unit running `docker compose up -d`** — compose *replays the dependency graph with
   health gating*, so the stack comes up ordered and ready (the same shape as megaflax's `deploy/aegis-up.sh`).
   The agency units below then `After=`/`Requires=` that unit, so a Warden never starts into a dead gatekeeper.

**Acceptance test (don't accept the fix on inspection — including "the compose has 77 health conditions,"
which is a reason to expect convergence, not evidence of it): a real reboot in a window, wait, then query the
KB WITHOUT touching the box.** Confirming containers are "up shortly after boot" is NOT valid — that's exactly
the check that misread a human running `compose up` as self-recovery. The valid check is a hands-off query.

## Step 1 — build the corpus ON flaxlap (a rebuild, not a copy)

The corpus is **sealed to the Warden's key** (`sealForWarden` → `encryptMessage`), so megaflax's `vault.json`
cannot be copied here — it must be **rebuilt** on flaxlap (~minutes; the 1366 passages are local sealed files,
not registry writes, so there is no seed-to-hyperswarm and no stall). Because flaxlap **resolves BTC:mainnet**,
**David is granted DURING the build** (`AGENCY_DAVID=<his DID>`) — no doorman, no `--owner-only`, no second
operation. This is flaxscrip's direct instruction to Aegis (see Step 2).

```sh
# on flaxlap, in the repo checkout (at ae1b075+), with the 0600 env file loaded:
HEARTHOLD_REGISTRY=local \
HEARTHOLD_NODE_URL=http://localhost:4222 \
HEARTHOLD_OLLAMA_URL=http://megaflax:11434 \
HEARTHOLD_ANSWER_MODEL=qwen3:8b \
HEARTHOLD_DATA_ROOT=/home/flaxscrip/.hearthold-agentic-warden \
HEARTHOLD_PASSPHRASE=<0600 secret> \
AGENCY_DAVID=did:cid:bagaaierar7rd7vkb5aq4ie4wzdlfpcxthvsi6q4uspn6zopy5amthleslyza \
npm run build:agency-kb
# copy the printed Warden DID → the Mage's HEARTHOLD_WARDEN_DID.
```

**DONE 2026-08-29** (flaxscrip's direct go to Aegis): 1366 passages / 240 chapters / 9 volumes; David granted;
vault 5.2 MB · index 28 MB. Warden `did:cid:bagaaierajafd6rsoosnlavkgat7qs2mfxr5477ha7ecpigy2oogp2jvfm7pq`.

**Embeddings note:** the build embeds 1363 passages via the single `HEARTHOLD_OLLAMA_URL` → megaflax, and that
is the **faster** option, not a compromise. Measured warm from flaxlap: megaflax over the tailnet embeds at
**~65 ms** vs flaxlap's own local `nomic` at **~105 ms** — the M1 Max GPU beats flaxlap's 2 GB Quadro by more
than the tailnet round-trip costs. So do **not** split embed/answer hosts: a local-embed split would add
~40 ms/embed (~55 s on the build, and per-query at serve time), adds config surface for a regression, and buys
nothing on availability (the answer model is on megaflax either way, so a split embeds the question then fails
to answer it). Single URL → megaflax.

## Step 2 — verify David's grant POSITIVELY, with a negative control

> The grant reads on a real person's mainnet DID; it is **flaxscrip's direct instruction to Aegis**, never
> relayed through an assistant. It happens in the Step-1 build (flaxlap resolves David). **Verify it — never
> infer from a clean exit code or the "David can query it" banner** (deny-by-default makes "failed" and
> "healthy" look identical from outside). The **negative control** is the part that makes the affirmative
> mean anything — a `testGroup` that returned `true` for every DID would pass the affirmative check alone.

```
david in members[] literally   true
testGroup(read, DAVID)         true     ← required
testGroup(read, STRANGER)      false    ← the control: without it, `true` proves nothing
david has WRITE                false    ← read-only, as intended
readGroup members: 2 (owner + David)
```

**Honest scope of the proof:** we cannot complete a login *as* David — only he holds his key. The strongest
available proof is **membership (above) + the owner's real challenge/response** (the Step-1 verify query, which
exercised login → session → a 6-citation answer end to end). State it that way to flaxscrip — *"membership
verified with a control; a David-login awaits David himself,"* **not** "login verified."

**Unconfirmed member DIDs:** if the grantee's DID resolves `confirmed=False` (pending updates not yet anchored
— e.g. a high `versionSequence`), **compare the CONFIRMED and LATEST signing keys** before declaring the grant
good. Login verification resolves the member's key; if confirmed and latest disagreed on it, the grant would
succeed while the login was refused. "Resolves clean" is not sufficient on its own. (Seen 2026-08-29:
flaxscrip's DID resolved v40 `confirmed=False` vs v35 confirmed — **identical** signing key, so safe.)

The KB has exactly **two members — David and Christian** (`flaxscrip@archon.social`, `did:cid:bagaaiera7vsj…`,
Christian's governor identity; **Christian *is* flaxscrip** — not a distinct third party, and the KB owner is
his identity too). David is `cypher@4tress.org` / `did:cid:bagaaierar7rd…`. Both were granted + verified with
the negative control on the FIRST (local-born) Warden — but that Warden is being replaced by the born-hyperswarm
rebuild below, so **both grants are re-done on the new identity** (David + Christian). Their first logins are
theirs to make once the rebuilt Warden + Mage are up.

## ⚠️ Member login requires a PUBLICLY-RESOLVABLE challenge (not `local`)

A member-gated KB's only door is login, and login mints a **challenge DID** the member's wallet must resolve
from **their own node** to sign it (`createResponse` throws `challengeDID does not resolve` otherwise). A
challenge minted on `local` resolves only on flaxlap — so **no member on another node can sign in** (found
live: the challenge was `notFound` on public gatekeepers). The KB's identity + access-control **groups** can
stay `local` (born-local: immediate, no gossip), but the **login challenge cannot**. The code now mints it on
`config.ephemeralRegistry` (a login challenge *is* ephemeral) — separate from the groups' `registry` — so:

**`HEARTHOLD_EPHEMERAL_REGISTRY=hyperswarm` alone is necessary but NOT sufficient** (measured by Aegis — do not
ship the code change as "the fix"). Keymaster **silently downgrades** a `local` agent's assets back to `local`:
`createAsset` resolves the controller `{confirm:true}` and, if it is registered `local`, rewrites the op's
registry to `local` rather than have the gatekeeper refuse it. That downgrade sits *below* `createChallenge`, so
it defeats the passed option, `ephemeralRegistry`, and `HEARTHOLD_REGISTRY` alike — measured: with the Warden's
env set to `hyperswarm`, a minted challenge still came back `registration: local` and `notFound` on public
gatekeepers, with **no error anywhere** (the downgrade is deliberate and quiet). The challenge's controller is
the Warden, and archon requires it **confirmed** on the target registry.

### ⛔ A `local`-born Warden CANNOT be migrated to a public registry (measured live)

`changeRegistry(warden, 'hyperswarm')` **does not work** for a `local`-born DID, and it reports **success** while
changing nothing off-box. `updateDID` queues the migration op under the identity's *current* registry (`local`),
and `queueOperation` drops local ops — so the move relabels the document locally and never announces itself.
Measured 2026-08-29: the moved Warden showed `registry=hyperswarm` on flaxlap but was `notFound` on public
gatekeepers, its entire op chain still `event.registry=local`. **`warden change-registry` now refuses a
local-born identity** rather than lie. (My two sandbox e2es — `changeregistry-unseal`/`-groups` — are correct
about keys-survive and groups-stay-manageable, but both observe flaxlap's OWN view; neither crosses to a second
node, the same blind spot as the login e2es one level up.)

So the agency Warden (born `local`) is **REBUILT born-hyperswarm** (flaxscrip's decision — with private
membership). Two other options were considered and rejected: admin export/import (`dids/export`→`dids/import`)
makes the Warden resolvable only from the *importing* node's DB — a `local` op chain still doesn't gossip, so
David's node never learns it via federation; the same "resolvable here, notFound from David's node" trap, plus
it would seed a private KB's Warden into the NIH-carrying production node's DB. And an upstream archon fix
(`updateDID` should queue the registry-change op on the **new** registry — right now **nothing born `local` can
ever federate**) is right long-term and worth escalating to macterra, but shouldn't gate David.

### The rebuild — born-hyperswarm identity, LOCAL groups (validated design)

`HEARTHOLD_REGISTRY=hyperswarm` (identity + challenges publicly resolvable → login federates) **+
`HEARTHOLD_GROUPS_REGISTRY=local`** (read/write groups stay local → membership never gossips). Validated by
Aegis on a genuinely born-hyperswarm identity: it confirms on hyperswarm **immediately**, and a hyperswarm
Warden **creates + grants + `testGroup`s a `local` group** with a BTC:mainnet member (the gatekeeper only
forbids a *local* controller creating a *non-local* asset, not the reverse — `gatekeeper.ts:462`). The new
`HEARTHOLD_GROUPS_REGISTRY` knob (defaults to the identity registry) is what splits them.

```sh
HEARTHOLD_REGISTRY=hyperswarm \            # Warden identity + login challenges → publicly resolvable
HEARTHOLD_EPHEMERAL_REGISTRY=hyperswarm \  # challenges (redundant with a hyperswarm identity, explicit is good)
HEARTHOLD_GROUPS_REGISTRY=local \          # read/write groups → membership stays OFF the gossip network
HEARTHOLD_NODE_URL=http://localhost:4222 HEARTHOLD_OLLAMA_URL=http://megaflax:11434 HEARTHOLD_ANSWER_MODEL=qwen3:8b \
HEARTHOLD_DATA_ROOT=/home/flaxscrip/.hearthold-agentic-warden \
AGENCY_DAVID=did:cid:bagaaierar7rd7vkb5aq4ie4wzdlfpcxthvsi6q4uspn6zopy5amthleslyza \
npm run build:agency-kb        # grants David in-build; publishes the Warden endpoint (step ▶5); then grant Christian:
warden kb-grant did:cid:bagaaiera7vsjlu6oiluzd4enop5j7sfzjbwp2ujudt6uunkz6hhd4lgfe4sa read --kb agency
```

The result: a **NEW Warden DID** (the old local-born one is discarded, not migrated) — copy it into the Mage's
`HEARTHOLD_WARDEN_DID`. The corpus is re-ingested identically (the book is public; no data loss); David + Christian
re-granted; the Mage unit is unchanged. Then — and only then — challenges resolve off-node and the downgrade
never fires.

- **The build now advertises the Warden's DIDComm endpoint itself** (build step ▶5 → `transport.ready()`), so
  the Mage can reach it without a manual `warden republish`. On a Drawbridge-fronted node the write lands but the
  `processEvents` apply-nudge can't run (`Cannot POST /api/v1/events/process`) — since `transport.ts` split the
  WRITE from the nudge, that is a **warning, not a failure**: the endpoint publishes, the node drains its own
  queue. (Previously this threw and made `republish`/serve-startup report a false failure on a successful write.)
- **RESOLVED — per-login gossip is a non-issue** (Aegis, measured on a genuinely separate node, 2026-08-29): a
  fresh login challenge minted via the public front resolves on `archon.technology` at **t+0s, first attempt,
  sub-second** — no `createResponse` retry / TTL change needed. Drop it from the risk list.
- **Federation prereqs — CONFIRMED live:** the born-hyperswarm Warden and its login challenges resolve on a
  DIFFERENT node (`archon.technology`, `error=None, doc=PRESENT`); `readGroup` is `notFound` off-node (membership
  stays private). The bug that blocked login (`challengeDID does not resolve`) is closed.
- **Acceptance test — the ONE step still pending:** a **member** (Christian/flaxscrip or David) signs in from a
  wallet pointed at a **public** node, end to end. The owner-driven full journey through flaxlap passes but does
  **not** count (owner resolves same-node — the trap that hid this bug in every prior attempt). Aegis cannot run
  it (doesn't hold their keys); it needs a real member.

## Step 3 — serve on flaxlap (Warden + member-login Mage; NO oracle)

Member-gated: the `kb-web` Mage runs **without** an oracle reader (no anonymous ask). Install the two systemd
units in this directory (`hearthold-agentic-{warden,mage}.service`) — **reconcile the flaxlap-specific paths
first** (node binary, repo dir, data root; Aegis provides these). Warden first (mailbox drainer), then the Mage.

## Step 4 — front it (archon-ops)

`agentic.archon.technology` → nginx → flaxlap over the tailnet, using the **deferred-resolution** pattern
(`set $var` + `resolver`), **never a literal upstream hostname** (a literal resolves at nginx startup and is
fatal to every vhost on the box, HATPro included). **Standalone cert lineage**, not the shared 13-SAN bundle.
HTTP-only vhost first so certbot can convert it (nginx won't start with an `ssl` listener and no cert).

> **Config lifecycle:** certbot rewrites the vhost file **in place** (adding the 443 block + redirect), so the
> LIVE config becomes `/etc/nginx/sites-available/agentic.archon.technology.conf`. Any staged copy (e.g.
> `~/archon-ops/agentic/…conf`) is then a **stale template** — edit the live file, not the template (same
> lifecycle as mages/hatpro). **Status: the front is LIVE** (HTTPS 200 serving the SPA at `ae1b075`, standalone
> single-name cert). `/api/*` returns **502 until the flaxlap Mage is up** — contained to this one host by the
> deferred resolution, by design.

**No anonymous route.** The KB is member-gated with no oracle, so the Mage exposes only the login/session
routes (`/api/kb/login/{start,callback}`, `/api/kb/login/poll`, `/api/kb/session-request`) — **no `/api/kb/ask`**.
So there is no oracle rate-limit zone; gate the whole `/api/` surface behind the standard api limit. The query
(`session-request`) path is a **reasoning** answer (`qwen3:8b`, ~30 s typical) — keep a generous
`proxy_read_timeout` (210 s, as mages uses); the login-poll is fast.

**Build the portal SPA out of tree — the SPA source + the login/session wire protocol are UNCHANGED across all
98 commits between the deployed tree and main (verified by diff), so it is version-safe; build it in an isolated
clone at a pinned commit and copy `dist-agentic` into place** — never in `/opt/hearthold` (that would add a 4th
untracked `dist-*` to the production tree, the drift #60 cleaned). The portal has **no `@hearthold/*` workspace
deps**, so it needs no `packages/*/dist` — **do NOT run the root `npm run build`** (that regenerates every
Warden's runtime under the six live services; the footgun this recipe used to carry):

```sh
# in an isolated clone, NOT /opt/hearthold:
cd apps/kb-portal && npm ci
VITE_PORTAL_URL=https://agentic.archon.technology \
VITE_KB_ID=agency \
VITE_MEMBER_GATED=true \
VITE_SIGNET_URL=https://wallet.archon.technology \
VITE_KB_TITLE='The Architecture of Agency' \
VITE_KB_EYEBROW='A Private Chronicle' \
VITE_KB_TAGLINE='Sign in to consult the manuscript.' \
npm run build -- --outDir dist-agentic
# then copy dist-agentic to the nginx document root on the archon host.
```

> **`VITE_MEMBER_GATED=true` is required for the agency KB.** Without it the SPA shows the anonymous
> "Consult" box (the public-oracle path), which a member-gated KB has no route for — the box would 404 and,
> worse, invite non-members to try to read a private corpus. With it, the consult box appears **only after
> sign-in** and queries ride the member's session. The current `dist-agentic` (built at ae1b075) predates this
> flag and MUST be rebuilt.

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
