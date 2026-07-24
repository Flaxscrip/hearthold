# Hearthold — an AI Agent's Guide to Deployment & Operations

**Audience:** an AI agent (Claude or otherwise) creating, configuring, or maintaining a live Hearthold
deployment — standing up a new Warden/Emissary pair, provisioning and governing Knowledge Bases,
managing trust-registry authorizations, or doing day-2 ops on an existing install like
`kb.archon.social`. This is an operational reference, not a tutorial — it assumes you can read the
repo. Where a command's exact syntax matters, it is quoted from the CLI source, not reconstructed
from memory.

**Read this first, once:** `/Users/flaxscrip/hearthold/CLAUDE.md` (or the project's `CLAUDE.md`) for
the architecture and the non-negotiable invariants. This guide operationalizes that document; it does
not restate the reasoning behind each invariant — see `docs/security-model.md` and
`docs/architecture.md` for that.

---

## 0. The one paragraph that governs everything

Hearthold separates the **custodian of data** (Warden — home-bound, local-only, never accepts a
public connection) from the **agent that acts in the world** (Emissary — carries, holds no secret,
decides nothing). A **Sovereign** (the human, via the Signet) authorizes; a **Verifier** trusts the
issuer's signature, never the Warden's word. Every operational decision below either preserves this
separation or it is wrong, no matter how convenient. If you find yourself about to give the Emissary a
copy of vault content, or make the Warden reachable from the public internet, stop — that is the
mistake this architecture exists to prevent.

---

## 1. Before you create anything: registry hygiene

**Read this before running a single `init`, `kb-init`, `kb-seed`, or e2e script.** This is the
single most common mistake an agent operating Hearthold will make, and it already happened once for
real (see `REGISTRY-HYGIENE-BRIEF.md` and `did-creation-source.md` in the repo root — a two-week
incident that put ~800 net-new agent DIDs on the public hyperswarm registry from test/demo runs whose
identities were never meant to be public).

**The rule:** every `did:cid` you create is a permanent, public, gossiped registration unless you
explicitly opt it into the `local` registry. Agent DIDs have no `validUntil` — there is no automatic
expiry or garbage collection. A DID registration is itself a disclosure (its existence and creation
timing are visible to every peer on the network), so registry egress deserves the same deny-by-default
posture the data plane already has: **a DID is born local, and promoted to a public registry only
deliberately.**

Concretely:

- **Any identity, credential, schema, group, or vault item created for testing, seeding demo data, or
  running an e2e/smoke script MUST use `registry: 'local'`.** Set `HEARTHOLD_REGISTRY=local` in the
  environment before running the command. Local DIDs resolve only on the node that created them and
  die with that node's DB — they cannot leak.
- **Only a real, permanently-serving identity** (a production Warden or Emissary meant to be publicly
  resolvable, e.g. the ones backing `kb.archon.social`) should use the default/public registry
  (`hyperswarm`, or whatever `HEARTHOLD_REGISTRY` / `DEFAULT_REGISTRY` resolves to in `core/config.ts`
  when unset).
- If you are unsure whether a given `init`/`kb-init`/seed operation is "real" or "test," treat it as
  test and use `local`. Promoting to public is cheap to do later and expensive to undo (agent DIDs
  cannot be deleted from the gossip log — only revoked, which tombstones but does not remove them).
- Before running anything under `scripts/e2e-*.ts`, `scripts/demo-*.ts`, `scripts/smoke-*.ts`,
  `scripts/proto-*.ts`, or `scripts/roleplay-*.ts`, check whether the script already sets
  `HEARTHOLD_REGISTRY=local` internally; if not, set it yourself in the shell before invoking `npm
  run e2e:*` / `demo:*` / etc. A script that is *deliberately* exercising cross-node resolution (e.g.
  `interop:registry`) is the sole exception — it is expected to be marked as such in its script name
  or a comment.
- `Keymaster.createAsset` and everything built on it (credentials, schemas, groups, vaults,
  challenges, responses, polls, dmail) reads the Keymaster instance's `defaultRegistry`, which is a
  **different knob** than the per-call `createId({ registry })` option Hearthold's own `identity.ts`
  passes. Setting `HEARTHOLD_REGISTRY=local` before opening the Keymaster handle should cover both, but
  if you are provisioning many auxiliary assets (KB access groups, schemas) and are unsure, verify with
  `warden status` / a DID resolution that `didDocumentRegistration.registry === 'local'`.

**If you suspect you polluted the public registry:** do not panic-delete anything (you can't). Identify
the controller DID for the affected fixtures, run `revoke_did` on what you still control to mark them
dead, and record the incident the way `REGISTRY-HYGIENE-BRIEF.md` does — root cause, fix, guard. Ask
before doing bulk revocation if you're not certain which DIDs are test fixtures versus live
infrastructure.

---

## 2. Prerequisites and environment sanity checks

Confirm these **before** attempting to create or reconfigure anything. All the commands below are
read-only.

```bash
node --version                                    # must be ≥ 22

# Archon node reachable, with DIDComm enabled (Drawbridge :4222, not the raw gatekeeper :4224):
curl -s $HEARTHOLD_NODE_URL/api/v1/version
curl -s $HEARTHOLD_NODE_URL/api/v1/capabilities   # want {"didcomm":true,...}
curl -s $HEARTHOLD_NODE_URL/didcomm/health        # want {"ready":true}

# Local classifier (Ollama), unless HEARTHOLD_CLASSIFIER=quarantine is intentional:
curl -s $HEARTHOLD_OLLAMA_URL/api/tags | grep $HEARTHOLD_CLASSIFIER_MODEL
```

If DIDComm isn't ready, nothing that follows will work — `submit`/KB queries route entirely over
DIDComm, addressing peers by `did:cid`, never by URL. There is no `WARDEN_URL`.

If the classifier is unreachable and `HEARTHOLD_CLASSIFIER` isn't explicitly set to `quarantine`,
every ingested artefact fails safe to `SEALED` — not a bug, but worth knowing before you conclude a
KB contribution "disappeared."

### Environment variables you will actually touch

| Var | Used by | Default | Notes |
|---|---|---|---|
| `HEARTHOLD_PASSPHRASE` | every agent | — | required; unlocks that agent's wallet. Separate wallets per agent, so a shared dev value is fine, but never reuse a prod passphrase in a test run. |
| `HEARTHOLD_NODE_URL` | every agent | `http://flaxlap.local:4222` | the Archon node (Drawbridge) |
| `HEARTHOLD_DATA_ROOT` | every agent | `~/.hearthold` | wallets + vault; **use a throwaway dir for anything test-related** — never point a test run at a real data root |
| `HEARTHOLD_REGISTRY` | every agent | `hyperswarm` (unless config default was flipped — check `core/config.ts`) | **see §1 — set to `local` for anything non-production** |
| `HEARTHOLD_WARDEN_DID` | Emissary | — | required for `submit` and for pointing a KB bridge at its Warden |
| `HEARTHOLD_CLASSIFIER` | Warden | `ollama` | `quarantine` disables the model and fails everything safe to `SEALED` |
| `HEARTHOLD_CLASSIFIER_MODEL` | Warden | `qwen3:8b` | local classifier model, must be `ollama pull`ed |
| `HEARTHOLD_OLLAMA_URL` | Warden | `http://localhost:11434` | on-device only — never point this at a cloud endpoint |
| `HEARTHOLD_PORTAL_PUBLIC_URL` | Emissary (`kb-web`) | — | baked into the login challenge callback; must be the public origin a member's wallet can reach, never `localhost` |
| `HEARTHOLD_CONTROL_PORT` / `HEARTHOLD_PORTAL_PORT` | per agent | 4310/4311/4312/4313 | local control-plane HTTP ports (Warden/Sovereign/Emissary/KB portal) — not the DIDComm transport |

---

## 3. Standing up a new deployment

The reference deployment is `kb.archon.social`; treat `deploy/INSTALL.md`, `deploy/OPERATIONS.md`, and
`docs/deploying-kb-portal.md` as the source of truth for exact commands — this section is the
decision structure around them.

**Topology:** two systemd services per KB-hosting deployment, both reaching the same local Archon node
over DIDComm (never a direct port):

- `hearthold-warden.service` — the custodian. Holds the vault and the KB(s). Never public.
- `hearthold-*-mage.service` (an Emissary in `kb-web` mode) — the world-facing bridge. Terminates the
  public HTTP connection, relays to the Warden over DIDComm, holds no secret.
- nginx in front of the Emissary's loopback port, terminating TLS, reverse-proxying `/api/kb/*` to the
  bridge and serving the static portal SPA (`apps/kb-portal/dist`) for everything else.

**Order of operations matters:** bring the **Warden up first** so its DIDComm mailbox has a drainer
before the Emissary can address it (`submit`/query hangs otherwise — see §9). Then the Emissary. Then
nginx/TLS.

**Two build-time gotchas that silently break a fresh deploy** (both documented in
`docs/deploying-kb-portal.md`):

1. **`VITE_PORTAL_URL` is baked into the SPA at build time**, not read at runtime. If you `npm run
   build` in `apps/kb-portal` without setting it, every visitor's browser calls
   `http://127.0.0.1:4313` from an HTTPS page → mixed-content block → "Failed to fetch," with no
   server-side error to grep for. Always:
   ```bash
   cd apps/kb-portal
   VITE_PORTAL_URL=https://<public-host> VITE_KB_ID=<kbId> VITE_SIGNET_URL=https://wallet.archon.technology \
     npm run build
   ```
   Verify after deploying: `curl -s https://<host>/assets/<bundle>.js | grep -c 127.0.0.1` should be
   `0`.
2. **The command is `emissary kb-web <port>`, not `witness kb-web`.** The world-facing role was renamed
   Witness → Emissary; an old unit file or script still invoking `witness` fails to launch the bridge
   and nginx returns 502 on every `/api/kb/*` call. The data folder also moved
   (`~/.hearthold/witness` → `~/.hearthold/emissary`) — if you're migrating an old install, that
   identity re-provisions and you'll need to re-check KB membership grants against its new DID.

**DIDComm reachability** (only relevant if the Warden and its Emissary/gateway are not co-located, or
you're wiring a cross-host A2A/CGPR path): see `docs/deploying-didcomm-relay.md`. Default to leaving
`ARCHON_DRAWBRIDGE_PUBLIC_HOST` unset so the node publishes a `.onion` DIDComm endpoint (hides which
host serves a given DID); only set it to a clearnet host when interop with non-Tor peers requires it.
The A2A edge (if you're running the CGPR gateway) is a separate, always-clearnet HTTPS surface — don't
confuse the two.

---

## 4. The wallet-mutating command safety protocol — non-negotiable

Any Warden command that creates keys, DIDs, groups, or policy chains
(`kb-init`, `kb-grant`/`kb-revoke`, `kb-govern`, `kb-policy`, `kb-spaces enable`, `delegate`, …)
writes `warden/wallet.json`. A live `warden serve` process holds that same wallet open. **Running a
second writer concurrently risks corrupting it.** Every time you need to run a mutating command against
a *live* deployment:

```bash
sudo systemctl stop hearthold-warden
tar czf ~/infra-backups/hearthold-warden/hearthold-warden-PRE-<change>-$(date +%Y%m%d-%H%M%S).tgz \
  -C <warden-data-root> warden
set -a; . /opt/hearthold/.env.warden; set +a
node packages/warden/dist/index.js <command>
node packages/warden/dist/index.js kb-status     # verify before restarting
sudo systemctl start hearthold-warden
```

Never skip the backup step to save time — it is one `tar` command, and the wallet holds the only copy
of the Sovereign-facing keys and every KB's group state. Backups live **outside the repo**, under
`~/infra-backups/` — never `git add` a backup archive or an env file; both contain secrets.

---

## 5. KB lifecycle — the `warden kb-*` command reference

All commands below are confirmed against `packages/warden/src/index.ts`. Run `warden help` for the
live, authoritative list — this table exists so you don't have to grep the source every time.

| Command | Usage | What it does |
|---|---|---|
| `kb-init` | `kb-init <kbId> [--governor <sovereignDid>] [--member-partitions] [--default-scope shared\|private]` | Provisions a new KB: creates its `kb-read-<id>` / `kb-write-<id>` Archon groups and a genesis governance Ruleset (Sovereign-signed if `--governor` given, else self-governed by the Warden). `--member-partitions` turns on per-member private DBs from day one. |
| `kb-govern` | `kb-govern <sovereignDid> [--kb <kbId>]` | Moves an existing (e.g. self-governed) KB under Sovereign governance in place. Members are preserved; **assurance resets to the factor1 baseline** — re-raise it afterward with `kb-policy`. Starts a fresh policy chain by design. |
| `kb-policy` | `kb-policy <action> <factor1\|factor2> [--kb <kbId>]` | Appends a signed policy version raising/lowering the assurance tier required for `<action>` (e.g. `write`) on the KB. Signed by the governor (Sovereign at the Signet, or the Warden if self-governed). |
| `kb-grant` / `kb-revoke` | `kb-grant <sovereignDid> [read\|write\|both] [--kb <kbId>]` | Adds/removes a DID from the read and/or write group. **If the KB has member partitions on, `kb-grant` also auto-provisions that member's private partition** — no separate step needed. Revoke does *not* delete the partition or its data; deletion is a deliberate, separate operation. |
| `kb-spaces enable` | `kb-spaces enable [--default-scope shared\|private] [--kb <kbId>]` | Retrofits member partitions onto an existing plain-shared KB: flips the flag and backfills a private partition for every *current* member. **Non-destructive** (existing shared content untouched) and **idempotent** (safe to re-run). Every future `kb-grant` after this provisions automatically. |
| `kb-status` | `kb-status` | Lists every KB on this Warden: read/write member counts and DIDs, and the current assurance tier per action. Read-only — the standard first move before and after any mutation. |
| `kb-seed` | `kb-seed [--set <name>]` | Loads a fixed demo card set into the KB. **Use only with `HEARTHOLD_REGISTRY=local` and a throwaway data root** — this is exactly the kind of operation that caused the registry-hygiene incident when pointed at a real registry/deployment. |
| `kb-reset` | `kb-reset [--kb <kbId>]` | Removes every artefact + index entry from the KB. Identity, access groups, and policy chain are untouched. Irreversible for the content — confirm you have a backup or truly mean to clear it before running against a live KB. |
| `kb-reindex` | `kb-reindex [--kb <kbId>]` | Backfills the recall index for any stored-but-unindexed artefacts (e.g. a contribution whose embed dropped because the embedder was overloaded). Idempotent, never duplicates. Safe to run any time; omit `--kb` to sweep every KB on the Warden. |

### Creating a new KB, end to end

```bash
# 1. Provision (Sovereign-governed is the norm for anything real):
node packages/warden/dist/index.js kb-init my-kb --governor <sovereignDid> --member-partitions --default-scope shared

# 2. Grant members (write implies contribute; each grant on a member-partitions KB
#    auto-provisions that member's private DB):
node packages/warden/dist/index.js kb-grant <memberDid> both --kb my-kb

# 3. Raise write assurance if the KB should require step-up beyond factor1:
node packages/warden/dist/index.js kb-policy write factor2 --kb my-kb

# 4. Verify:
node packages/warden/dist/index.js kb-status

# 5. Serve it (co-located with an emissary kb-web bridge — see §3):
node packages/warden/dist/index.js serve
```

### KB Spaces — what "private partition" actually means

A KB space is one shared partition (all members read; write per policy) plus, when
`memberPartitions` is on, **one private partition per member** — modeled internally as "just another
KB whose group has exactly one member," reusing the same group + policy machinery. Three properties
worth knowing before you operate one:

- **The visible set is computed server-side from the authenticated session DID, never from client
  input.** A member cannot request another member's partition by asking nicely — there is no
  parameter for it. If a query should see private content and doesn't, the fix is a `kb-grant`
  (membership), not a client-side flag.
- **Private-from-peers is cryptographically enforced; private-from-operator is not (Phase 1).** The
  Warden must unseal private content to index and answer over it, so whoever controls the Warden's host
  can read the keys and thus the content. This is inherent to local-AI RAG — say this plainly if asked
  about the privacy guarantee, don't oversell it. (Phase 2, federated private partitions living on the
  member's own Warden, closes this gap — check `docs/kb-spaces.md` for status before promising it.)
- **Two structural invariants apply to every KB you operate, shared or private** (from
  `docs/knowledge-portal.md`): the KB never becomes a store of a member's whole personal history (a
  member may *contribute* a consented, derived fact — the KB itself must stay a sphere brain, not a
  surveillance surface), and **query logging is off by default** — the Warden answers a query in
  memory and does not persist who asked what. Don't add per-DID query logging as an "ops metric"
  without treating that as a deliberate, reviewed policy change, not a convenience.

---

## 6. Trust registry management

There are two different things called "the registry" in this codebase — keep them separate:

1. **A KB's own read/write groups** (`kb-read-<id>` / `kb-write-<id>`), created by `kb-init` and
   managed with `kb-grant`/`kb-revoke`. This is the access-control mechanism for one specific KB. Use
   the `warden kb-*` commands from §5 for this — not the standalone registry package.
2. **The standalone `registry` package** (`packages/registry`) — a general-purpose TRQP (Trust
   Registry Query Protocol, ToIP v2.0) service over Archon groups, for authorizing arbitrary
   `(action, resource)` pairs. This is what you stand up when something *outside* one KB's membership
   needs a trust decision — e.g. which issuers a verifier should accept for a given credential schema
   (**outward** trust), or how much autonomy to grant one of your own agent DIDs at a given sensitivity
   level (**inward** trust, grading Emissary autonomy).

The governing principle (from `docs/trust-graph-and-delegation.md`): **thin credential, fat registry.**
Credentials themselves stay minimal (issuer + subject); everything policy-bearing — who counts as an
authorized issuer, what role a DID holds, whether it's still authorized — lives in the registry, so
revocation and re-scoping never require reissuing credentials.

### `registry` CLI reference

Confirmed against `packages/registry/src/index.ts`:

| Command | Usage | Notes |
|---|---|---|
| `init` | `registry init` | Provisions the registry's own identity |
| `status` | `registry status` | Identity + binding count |
| `bind` | `registry bind <action> <resource> [existingGroupDid]` | Creates (or reuses) the Archon group backing an `(action, resource)` pair. Pass an existing group DID to bind to a group created elsewhere (e.g. a board's membership group) instead of minting a fresh one. |
| `grant` / `revoke` | `registry grant <action> <resource> <did>` | Authorizes/de-authorizes `<did>` for that pair (adds/removes it from the bound group) |
| `check` | `registry check <action> <resource> <did>` | Read-only query; exit code 0 = authorized, 1 = not |
| `list` | `registry list` | Every binding, its member DIDs, and its backing group |
| `serve` | `registry serve [port]` | Serves TRQP over HTTP — `POST /authorization {entity_id, action, resource}`, `GET /metadata`, `GET /health`. Default port 4262. |

`<action>` is one of `issue | verify | hold | present | revoke`; `<resource>` is a schema DID (outward
use) or a sensitivity level like `HIGH` (inward use), or `*` for the per-action wildcard.

### Which evaluator is in play

- `GroupTrustRegistry` — runs in-process over Archon groups; this is what backs both the KB
  read/write model and a self-hosted `registry serve`.
- `HttpTrustRegistry` — consumes a *remote* TRQP registry over HTTP; use this when you want Hearthold
  to defer trust decisions to an external registry someone else operates (e.g. the HATPro travel
  ecosystem's `archon-trust-registry` deployment).
- Both implement the same `TrustEvaluator` seam, so `verifyResponse` and the projector's inward checks
  work identically regardless of which is behind them. `check`'s exit code makes it scriptable —
  prefer it over reading `list` output when you just need a yes/no in an automated flow.

Interop note if you're pointing Hearthold's `HttpTrustRegistry` at someone else's TRQP registry: some
deployments require `authority_id` on every query. Hearthold's client always sends it; Hearthold's own
`serve` treats it as optional — don't assume the reverse holds for a third party's registry.

---

## 7. Delegation, Rulesets, and the release ladder (know this before granting anything sensitive)

Every disclosure — a KB answer, an evidence-graph proof, a CGPR grant — crosses one deny-by-default
decision, `decideRelease()`:

```
release(request, artefact):
  if artefact.sensitivity == PUBLIC: allow
  if not delegationValid(request): deny "no/expired delegation"
  if not tierSatisfied(request.tier, request): deny "tier not satisfied"
  if not clearsSensitivity(request.tier, artefact.sensitivity): deny "insufficient authorization"
  if not disclosureSatisfiable(request.mode, artefact): deny "cannot satisfy disclosure mode"
  emit auditEntry
  allow with disclosureTransform(request.mode, artefact)
```

The authorization ladder (`docs/security-model.md`):

| Tier | Requires | Clears up to |
|---|---|---|
| `STANDING` | valid, unrevoked delegation credential | `LOW` |
| `CHALLENGE` | Standing + fresh Archon challenge/response | `MEDIUM` |
| `HUMAN` | Challenge + human-in-the-loop approval | `HIGH` |
| `MULTIFACTOR` | Human approval co-signed by a second device | `SEALED` |

**Every candidate disclosure must be produced *through* `decideRelease()` and the live Ruleset chain —
a disclosure assembled around the Warden is not a smaller or more convenient result, it is invalid at
any size.** If you're ever tempted to write a shortcut that hands out vault content without routing
through the release path (a debug endpoint, a "just this once" script), don't — put new gating *inside*
the release path so no future surface can forget it, per the architectural invariant.

**Non-negotiable invariants** (verbatim intent from the project's `CLAUDE.md` — do not trade these away
for operational convenience):

- **Deny-by-default release ladder** — sensitive content always triggers a step-up.
- **The Warden authors all consent text.** A requester's description of what it wants is input
  evidence, never the consent screen a human sees — this is structural, not a convention, precisely
  because an AI requester can misdescribe what it's asking for.
- **No subject identifier before approval.** No CGPR message — including denials — may carry the
  Sovereign DID, a pairwise DID, or any account handle before the human approves.
- **A fresh pairwise DID per audience/counterparty.** Reusing a stable DID across external grants is
  refused unless the active Ruleset carries a signed exception for that specific audience.
- **A2A only at the edge.** No A2A types reach `@hearthold/core`; internally everything stays DIDComm
  v2 + the Hearthold wire protocol.
- **On-device classification, fail-safe to `SEALED`.** Artefact content never leaves the machine for
  classification.

If an operational task seems to require violating one of these, the task's design is wrong, not the
invariant.

---

## 8. Day-2 operations

### Health check
```bash
systemctl is-active hearthold-warden hearthold-kb-mage
journalctl -u hearthold-warden -f     # expect "Warden serving …"; a portal login logs
                                       # "login-start received → challenge issued"
curl -s https://<public-host>/ | head
```

### Upgrade in place
```bash
cd /opt/hearthold && git pull --ff-only origin main && npm run build
sudo systemctl restart hearthold-warden hearthold-kb-mage   # they share the wire protocol — restart together
# only if the portal frontend changed:
cd apps/kb-portal && VITE_PORTAL_URL=https://<host> VITE_KB_ID=<kbId> VITE_SIGNET_URL=https://wallet.archon.technology npm run build
```

### Backup hygiene
- Keep backups under `~/infra-backups/` — never inside the repo, never `git add`ed.
- `.env.*` files are gitignored and mode `0600`. Never commit wallet or vault state, ever, even
  transiently.
- Before any wallet-mutating command against a live deployment, back up first (§4) — no exceptions.

### Rollback
```bash
sudo systemctl disable --now hearthold-kb-mage.service
sudo systemctl disable --now hearthold-warden.service
sudo rm /etc/nginx/sites-enabled/<host>.conf && sudo systemctl reload nginx
```

---

## 9. Troubleshooting quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| `submit` / a KB query hangs or times out | The Warden published its DIDComm endpoint (so the send succeeded and the message is queued in the relay) but no `warden serve` is draining the mailbox | Start `warden serve`. This is the standard cause — check it before assuming a networking problem. |
| `recipient has no DIDCommMessaging endpoint` | The Warden never published its endpoint | Run `warden init` (publishes) or `warden publish`, once the node's DIDComm is confirmed up |
| `Warden refused: no valid delegation` | No delegation credential recorded for the requesting DID | `warden delegate <emissary-did>` (or `kb-grant` for KB access) |
| `HEARTHOLD_PASSPHRASE is required` | Not exported in that terminal/service env | Export it (or check the systemd unit's `EnvironmentFile`) |
| `HEARTHOLD_WARDEN_DID is required for submit` | Not set on the Emissary side | Export it to the Warden's `did:cid` |
| `invalid ghash tag` / wallet won't open | Wrong passphrase for an existing wallet | Confirm the correct passphrase before doing anything destructive; do **not** `rm -rf` a data root you don't own a fresh copy of |
| Portal shows "Failed to fetch" from an HTTPS page | `VITE_PORTAL_URL` wasn't set at build time — SPA is calling `127.0.0.1` | Rebuild with `VITE_PORTAL_URL` set (§3) |
| `/api/kb/*` returns 502 | The bridge is invoking the old `witness kb-web` command, or isn't running | Use `emissary kb-web`; check `systemctl status` on the bridge unit |
| `"no private partition for you on this KB"` | Caller isn't a granted member of a member-partitions KB | `kb-grant <did> write --kb <kbId>` (auto-provisions the partition) — see §5 |
| A browser-visible CORS error that doesn't match the actual failure | An upstream 429/502/504 on a route with no nginx-level CORS fallback, so the browser reports the missing header instead of the real status | Check the actual upstream status (curl it directly, bypass the browser) before chasing CORS — see `deploy/OPERATIONS.md`'s 2026-07-13 entry for the exact case |
| A burst of new DIDs shows up in registry/mediator logs after a test run | A test or seed script ran without `HEARTHOLD_REGISTRY=local` | Stop, don't repeat it — see §1. Identify and `revoke_did` what you control; file the incident. |

---

## 10. Where to go deeper

| Topic | Doc |
|---|---|
| Architecture, the four agents, invariants | `CLAUDE.md`, `docs/architecture.md` |
| Sensitivity/authorization/disclosure model | `docs/security-model.md` |
| Evidence graphs, proving facts | `docs/evidence-graph.md` |
| DTG credentials, delegation, inward/outward trust | `docs/trust-graph-and-delegation.md` |
| KB Spaces design (shared + private partitions) | `docs/kb-spaces.md` |
| Portal architecture and invariants | `docs/knowledge-portal.md` |
| Portal redeploy checklist | `docs/deploying-kb-portal.md` |
| DIDComm relay provisioning (clearnet/.onion) | `docs/deploying-didcomm-relay.md` |
| A2A / CGPR gateway | `docs/a2a-cgpr.md` |
| First-time install | `deploy/INSTALL.md` |
| Live change history + maintenance runbook | `deploy/OPERATIONS.md` |
| Manual CLI walkthroughs, full command tables | `docs/manual-testing.md` |
| The registry-hygiene incident (read before seeding demo data) | `REGISTRY-HYGIENE-BRIEF.md`, `did-creation-source.md` |

This guide is meant to be kept current the way `deploy/OPERATIONS.md` is — if you learn an operational
lesson the hard way, add it here (or to the troubleshooting table) rather than letting it live only in
your own run history.
