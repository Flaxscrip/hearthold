# Deploying the private "agency" KB (David's corpus) on megaflax — loopback-first

A **private, member-gated** Knowledge Base of David's *Architecture of Agency* corpus (9 volumes, ~1366
passages), served by a single-purpose **KB Warden + kb-web Mage** pair on **megaflax** (M1 Max Mac →
macOS LaunchAgents). **Bound to 127.0.0.1 only** — nothing faces the network. The endpoint (how David
reaches it) is **deliberately deferred to the handoff**, per Aegis: build it, serve it on loopback, verify
a real member query, and decide exposure only when the gift is actually given. If David self-hosts, we never
open anything.

Members: the owner + **David** (`cypher@4tress.org` → `did:cid:bagaaierar7rd7vkb5aq4ie4wzdlfpcxthvsi6q4uspn6zopy5amthleslyza`).
A non-member is refused at the challenge/response wall. The manuscript never leaves the custodian.

## ⚠️ Two things to know before running (Aegis measured these on megaflax)

1. **This KB is intentionally SLOWER than the mages KB — by design.** It is `answerThink:true` (a book
   corpus deserves a reasoning pass), answered by `qwen3:8b`. Measured on this host: **~27s** thinking vs
   ~19s with thinking off — roughly +40–50%, and far from the ~4.5s no-think mages experience. **A book KB
   answering in ~20–30s is the intended trade** (deep questions, thoughtful answers) — not a regression. To
   make it fast instead, set `answerThink:false` in the KB config (or a smaller `HEARTHOLD_ANSWER_MODEL`).
2. **Memory:** the three Ollama models are already resident (qwen3:8b/qwen2.5:3b/nomic — ~12.3 GB); the
   Warden + Mage processes are small (~100 MB each). No thrash expected, but **measure residency after
   standing it up** rather than assume (the failure we just spent an evening on).

## Prereqs
- Repo built on megaflax (`npm run build`) at a known path → set `HEARTHOLD_APP` in the env files.
- Ollama on megaflax has `qwen3:8b` resident (confirmed). `HEARTHOLD_ANSWER_MODEL=qwen3:8b`.
- Two 0600 env files under `~/.hearthold-agency/`:
  - `.env.agency-warden`: `HEARTHOLD_PASSPHRASE`, `HEARTHOLD_DATA_ROOT=~/.hearthold-agency-warden`,
    `HEARTHOLD_REGISTRY=local`, `HEARTHOLD_ANSWER_MODEL=qwen3:8b`, `HEARTHOLD_NODE_URL=<megaflax node>`,
    `HEARTHOLD_APP=<repo path>`, `HEARTHOLD_NODE=<node bin>`.
  - `.env.agency-kb-mage`: same passphrase/model/node/app, `HEARTHOLD_DATA_ROOT=~/.hearthold-agency-kb-mage`,
    and `HEARTHOLD_WARDEN_DID=<the agency Warden did>` (filled in after step 1).

## Step 1 — build the KB (populates the Warden; grants membership) — **flaxscrip's explicit GO required**
> This grants read membership on a real person's DID (David). Run only on flaxscrip's direct go.
```sh
set -a; . ~/.hearthold-agency/.env.agency-warden; set +a
cd "$HEARTHOLD_APP"
npm run build:agency-kb          # full corpus, kbId "agency" — ~60s; resolves David + grants read to owner+David
# note the Warden did it prints; put it in .env.agency-kb-mage as HEARTHOLD_WARDEN_DID
```
Verify at the end: it prints a member query answered through the challenge/response wall (reasoned, ~20–30s).

## Step 2 — serve (loopback), Warden first
```sh
mkdir -p ~/.hearthold-agency
cp "$HEARTHOLD_APP/deploy/agency/"*.plist ~/Library/LaunchAgents/     # adjust the paths inside each plist
launchctl load -w ~/Library/LaunchAgents/com.hearthold.agency-warden.plist
launchctl load -w ~/Library/LaunchAgents/com.hearthold.agency-kb-mage.plist   # after the Warden did is wired
```

## Step 3 — verify (loopback)
```sh
tail -f ~/.hearthold-agency/agency-warden.err     # expect "Warden serving over DIDComm … serving … agency"
tail -f ~/.hearthold-agency/agency-kb-mage.err    # expect "KB Portal … relaying to Warden …"
curl -s http://127.0.0.1:4313/ | head             # the Mage responds on loopback
# A member (owner/David) login round-trip should surface in the WARDEN log as a kb login-start (kb=agency).
# measure model residency: ollama ps  (expect qwen3:8b + nomic resident, no swap thrash)
```

## The endpoint (deferred)
Do NOT open a public/tailnet endpoint speculatively. When the handoff happens, the proven pattern is the
archon-ops nginx proxying megaflax over the tailnet (as `sovereign.archon.technology` already does) —
that's coordination with archon-ops, not a megaflax-only step. Or hand David a self-contained bundle to
self-host (see the gift-bundle handoff design: the KB config DIDs must resolve on his node — rebuild the
config on `hyperswarm`, or export the config DIDs alongside the vault/index files, and test on a fresh host).

## Rollback
```sh
launchctl unload -w ~/Library/LaunchAgents/com.hearthold.agency-kb-mage.plist
launchctl unload -w ~/Library/LaunchAgents/com.hearthold.agency-warden.plist
# the KB data is self-contained under ~/.hearthold-agency-warden — remove it to fully undo.
```
