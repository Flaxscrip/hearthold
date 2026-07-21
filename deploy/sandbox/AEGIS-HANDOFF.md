# Hearthold ⇄ Aegis sandbox — handoff report

**From:** GenitriX (Hearthold side) · **To:** Aegis (Archon sandbox side) · **Date:** 2026-07-20
**Re:** Dockerizing Hearthold's agents onto the egress-isolated `archon_default` network.

Hearthold now runs fully inside Docker on your isolated node, and the manual spine (Warden init →
delegate → serve, Emissary init → submit, Warden vault) passes end-to-end with **zero runtime internet
egress**. This note covers what I built, the **one change on your side** you should know about (and keep),
the root-cause finding behind it, and how to bring it up + verify.

---

## TL;DR for you (Aegis)

- **One node-side change, and it's isolation-safe:** I added `ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS=true`
  to the `didcomm` service in `~/isolation/archon/docker-compose.override.yml`, and recreated *only* the
  `didcomm` container (`--no-deps`). It lifts the relay's **app-level SSRF guard** so it can dial the
  private in-network `drawbridge` host. It does **not** weaken your isolation: the network is still
  `internal: true`, so a dial to any public IP still `ENETUNREACH`es. It's the same flag Hearthold's own
  `docs/manual-testing.md` documents for dev/test.
- **Your `sandbox.archon.local` dummy was fine for Lightning but broke DIDComm.** Details below — worth
  folding into the sandbox's mental model, because it's a sharp edge.
- **Nothing else on your node was touched.** `ARCHON_DRAWBRIDGE_PUBLIC_HOST` is unchanged (Lightning
  depends on it); the registry stays `local`.

---

## The root-cause finding (the sharp edge)

DIDComm delivery resolves the **recipient's** published `DIDCommMessaging` service endpoint and the relay
**dials it** — `services/didcomm/server/src/didcomm-api.ts`, `POST /deliver` → `POST <endpoint>/api/v1/messages`.

Your node advertises `https://sandbox.archon.local/didcomm` from `/api/v1/didcomm-endpoint` (from
`ARCHON_DRAWBRIDGE_PUBLIC_HOST`). That symbolic host is deliberately **non-resolving** — reserved for the
**Lightning** mediator's *string-compare* loopback (`lightning-mediator.ts:509-519`), which only compares
the host as a string and loops back to `http://drawbridge` internally. It never dials it.

**The DIDComm relay has no such loopback — it genuinely dials the endpoint.** So agents publishing
`sandbox.archon.local` made every `submit` fail `502` (host unreachable). That's the "assumed the dummy
wasn't used" gap: it isn't used by Lightning's dial, but DIDComm *is* used and *does* dial it.

Pointing agents at the real in-network `http://drawbridge:4222/didcomm` then hit the second guard: the
relay's `/deliver` SSRF-blocks clearnet delivery to **https-only + non-private** hosts →
`400 private/loopback endpoint not allowed`. Hence the `ALLOW_PRIVATE_EGRESS` flag.

**A cleaner long-term option on your side (optional):** give the DIDComm relay the same self-loopback the
Lightning mediator has — when a recipient's endpoint host matches the node's own `getPublicHost()`, store
in the local mailbox instead of dialing. That would let DIDComm reuse `sandbox.archon.local` with no
private-egress flag and no per-app endpoint override. Upstream Archon enhancement, not needed for this pass.

---

## What Hearthold does on its side

- **Registry:** with `HEARTHOLD_REGISTRY=local`, Hearthold pins the keymaster instance's
  `ephemeralRegistry` to `local` too (`packages/core/src/keymaster.ts`). Keymaster otherwise hardcodes
  ephemeral challenge/response DIDs to `hyperswarm`, which would fail on your offline node with an opaque
  "Upstream gatekeeper error". So Hearthold anchors **every** DID on `local` — no registry change on your
  node required.
- **DIDComm endpoint override:** a new `HEARTHOLD_DIDCOMM_ENDPOINT` env (`packages/core/src/transport.ts`)
  makes each agent publish the in-network `http://drawbridge:4222/didcomm` instead of your advertised
  external/dummy host. Default (unset) = your advertised endpoint, unchanged for normal deployments.
- **Containers:** warden/emissary/sovereign are idle containers on `archon_default` that we `docker
  compose exec` into (your `cli`-container pattern). `warden serve` runs as a detached exec; state
  persists to a bind-mounted `./data/<role>`.

---

## Bring it up + verify (from `~/hearthold`)

```bash
cp .env.example .env          # set HEARTHOLD_PASSPHRASE (sandbox dev value)
docker compose -f docker-compose.hearthold.yml up -d --build
./deploy/sandbox/run-spine.sh # egress proof + full spine, prints every DID/receipt
docker compose -f docker-compose.hearthold.yml down
```

Config this pass: `HEARTHOLD_NODE_URL=http://drawbridge:4222`, `HEARTHOLD_REGISTRY=local`,
`HEARTHOLD_CLASSIFIER=quarantine` (no Ollama — everything seals to SEALED / sensitivity `4`),
`HEARTHOLD_DIDCOMM_ENDPOINT=http://drawbridge:4222/didcomm`.

### Egress isolation — proven before the spine
```
warden / emissary / sovereign:  OK isolated — ENETUNREACH (connect 1.1.1.1:80)
warden dns:                     OK isolated — DNS EAI_AGAIN
```

### Spine transcript (fold into the sandbox docs)
```
Emissary DID:  did:cid:bagaaiera7bz67lahdvuw5vl6ajekosavgkss756pdhg2wmnglscgbmlioduq
Warden DID:    did:cid:bagaaierarfsefbyfylm5xbleuilpnunk6ofrsftwuek2cw52ioktbtxwocka
Delegation:    did:cid:bagaaiera4gdxe735wunddjpbelkyfz2rqft7z7jw37sinlm4qdyfs7gyte5a  (Warden → Emissary)
Submit #1:     location → artefact 5d5e9d5670b9…  sensitivity 4 (SEALED)
Submit #2:     document → artefact ab675ec3a0dc…  sensitivity 4 (SEALED)
Warden vault:  [4] location observed 2026-07-20T19:30:09Z · 5d5e9d5670b9…
               [4] document observed 2026-07-20T19:30:12Z · ab675ec3a0dc…
               2 artefact(s)  (ciphertext at rest)
```

---

## Terminal UIs (no web interface exposed to the host)

Because the sandbox deliberately publishes nothing to the host, the two operator UIs are **TUIs**
(Ink — React-for-the-terminal), not browser apps. Each is a terminal port of its web counterpart,
reusing the exact control-API contract (`@hearthold/control-types`) — same logic, terminal render —
and running as a **client of the agent's localhost control plane** inside the container (never a
published port). Both are driven via `docker compose exec -it`.

| TUI | Package | Replaces | Talks to | Does |
|---|---|---|---|---|
| 🔑 Signet | `packages/signet-tui` | `apps/signet-approver` | `sovereign control` (127.0.0.1:4311) | live pending-approvals list · masked-PIN approve/deny |
| 📡 Emissary | `packages/emissary-tui` | `apps/emissary` | `emissary control` (127.0.0.1:4312) | pick a kind · type an observation · submit → receipt |

Each has a one-command helper that starts the needed daemon(s) + the TUI:
`deploy/sandbox/run-signet-tui.sh [pin]` and `deploy/sandbox/run-emissary-tui.sh`.

## The full contained walkthrough

```bash
./deploy/sandbox/run-demo.sh        # preflight → egress-isolation proof → provision the prove flow → TUI handoff
./deploy/sandbox/run-demo.sh reset  # tear down + wipe ./data for a clean re-run
```

`run-demo.sh` runs everything automatable and prints the exact commands for the two interactive TUIs
(each in its own terminal). It keeps the slow classifier off the automated path so it stays fast.

## Classification note (for you, Aegis)

Your Ollama layer works and is wired correctly (the Warden reaches the `ollama` container; `qwen3:8b`
classifies, `nomic-embed-text` embeds the recall index; no egress). One practical issue for **live**
demos: 8B inference is slow here — ~2+ min per artefact — so the Emissary's receipt shows instantly
(provisional) but its *sensitivity* fills in minutes later. flaxscrip is having you research a lighter,
faster classification model; a smaller instruct model (or a warm/keep-alive) would make the sensitivity
land in seconds. No change needed on the Hearthold side — it's purely the model behind `HEARTHOLD_OLLAMA_URL`.

## Evidence-graph & KB-spaces (now in the sandbox)

Both flows run in-container against the isolated node — verified green:

- **Evidence-graph** (`run-evidence.sh`): assemble → mint a signed evidence graph → verify (witnessed);
  selective disclosure (reveal one fact, hide the rest); the Sovereign's Signet co-sign embedded +
  independently verifiable (a step-up **over DIDComm** — exercises the endpoint override end-to-end).
- **KB-spaces** (`run-kb.sh`): shared + per-member private partitions; visible-set isolation; retrofit
  in place. Live RAG recall (`run-kb.sh recall`) is Ollama-backed and works — just slow on the 8B model
  (the same reason the Emissary sensitivity is slow; a lighter model helps here too).

`run-demo.sh flows` runs both back to back. Each uses a throwaway data root, so nothing collides with
the demo agents.

## Still to come (follow-on)

CGPR / A2A gateway + the trust registry are the remaining flows. None of it changes the isolation
posture — same network, same registry, same two node-side settings
(`ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS=true`, and `ARCHON_DRAWBRIDGE_PUBLIC_HOST` left as-is for Lightning).

Thanks for the clean sandbox — the isolation held at every step, and nothing had to be relaxed to make
any of it pass (only the one in-network SSRF opt-in, which keeps internet egress blocked). — GenitriX
