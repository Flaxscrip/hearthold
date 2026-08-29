# Deploying the private "agency" KB (David's corpus) on megaflax — containerized, loopback-first

A **private, member-gated** Knowledge Base of David's *Architecture of Agency* corpus (9 volumes, ~1366
passages), served by a single-purpose **KB Warden + kb-web Mage** pair, **containerized on megaflax's sealed
network** (`aegis_internal`) from the `hearthold:invocation` image — because a native host process cannot
reach the sealed Archon node or the sealed Ollama (Aegis's catch: `table-gateway` / `ollama` resolve only
inside that internal network). **Loopback-first is preserved**: kb-web is reachable from the host only via
Aegis's tcp-forward bridge to `127.0.0.1`; nothing binds a public interface. The **endpoint (how David
reaches it) is deferred to the handoff** — build it, serve it sealed, verify a member query, decide exposure
only when the gift is given. If David self-hosts, we open nothing.

Members: the owner + **David** (`cypher@4tress.org` → `did:cid:bagaaierar7rd7vkb5aq4ie4wzdlfpcxthvsi6q4uspn6zopy5amthleslyza`).
A non-member is refused at the challenge/response wall; the manuscript never leaves the custodian.

## ⚠️ Two things to know before running (Aegis)

1. **This KB is intentionally SLOWER than the mages KB — by design.** It is `answerThink:true` (a book
   deserves a reasoning pass), answered by `qwen3:8b`. Expect **~20–30s per answer** vs the ~4.5s no-think
   mages experience — the intended trade for deep questions, **not a regression**. Toggle `answerThink:false`
   (or a smaller `HEARTHOLD_ANSWER_MODEL`) to make it fast. NOTE: measure on the **sealed `aegis-ollama-1`**
   instance (a different Ollama than the host/tailnet one the ~4.5s figure came from).
2. Confirm **`aegis-ollama-1` has `qwen3:8b` resident** (it mounts the host model store read-only, so it
   should) and **measure model residency** after standing up — don't assume.

## Prereqs
- `hearthold:invocation` image current on megaflax (rebuilt from `main` including the thinking work).
- A gitignored `.env` beside the compose: `HEARTHOLD_PASSPHRASE`, `HEARTHOLD_DOCKER_NETWORK=aegis_internal`
  (the sealed net name), and — after Step 1 — `AGENCY_WARDEN_DID=<the agency Warden did>`.
- Host bind-mount dirs `./data-agency` (the KB) and `./data-agency-mage` (the Mage's minimal data).

## Step 1 — build the KB (populates the Warden; grants membership) — **flaxscrip's DIRECT go to Aegis**
> This grants read membership on a real person's DID (David). It runs INSIDE a container on the sealed net
> (a host `npm run` can't reach the node). Aegis runs it only on flaxscrip's direct word — never a relay.
```sh
# bring up the warden container (idle enough to exec into), then run the build inside it on the sealed net:
docker compose -f deploy/agency/docker-compose.agency.yml up -d agency-warden
docker compose -f deploy/agency/docker-compose.agency.yml exec \
  -e HEARTHOLD_ANSWER_MODEL=qwen3:8b agency-warden \
  node --experimental-strip-types scripts/build-agency-kb.ts        # full corpus, kbId "agency" (~60s)
# it resolves David + grants READ to owner+David, ingests 9 volumes, and verifies a member query.
# copy the printed Warden did into .env as AGENCY_WARDEN_DID.
```

## Step 2 — serve the pair (sealed), then bridge kb-web to host loopback
```sh
docker compose -f deploy/agency/docker-compose.agency.yml up -d        # warden + kb-web mage
# then, via Aegis's established tcp-forward bridge, publish the Mage to the HOST's 127.0.0.1:<port>
# (the same pattern that reaches the existing sealed services from the host) — NOT a public bind.
```

## Step 3 — verify (loopback)
```sh
docker logs -f agency-warden      # expect "Warden serving over DIDComm … serving … agency"
docker logs -f agency-kb-mage     # expect "KB Portal … relaying to Warden …"
curl -s http://127.0.0.1:<bridged-port>/ | head        # the Mage answers on host loopback via the bridge
docker exec aegis-ollama-1 ollama ps                    # qwen3:8b + nomic resident; no swap thrash
# a member (owner/David) login round-trip shows in the WARDEN log as a kb login-start (kb=agency).
```

## The endpoint (deferred)
Do not expose speculatively. At handoff, the proven pattern is archon-ops's nginx proxying megaflax over the
tailnet (as `sovereign.archon.technology` already does) — coordination with archon-ops, not a megaflax-only
step. Or hand David a self-contained bundle to self-host: the KB is `vault.json` + `index.json` (portable
files) PLUS the config DIDs (read/write groups + assurance + identities) which must RESOLVE on his node —
rebuild the config on `hyperswarm`, or export the config DIDs alongside the files, and **test on a fresh
host that has never seen it** (the only real portability proof).

## Rollback
```sh
docker compose -f deploy/agency/docker-compose.agency.yml down
# the KB data is self-contained under ./data-agency — remove it to fully undo.
```
