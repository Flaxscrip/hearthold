# Hearthold — Manual Launch & Test

How to launch and exercise what's built: the delegation handshake and the witness→store→receipt
loop over the **DIDComm v2** transport. (The "prove" half — evidence + step-up — is not built yet;
see [PLAN.md](PLAN.md).)

## 0. Prerequisite: the Archon node + DIDComm must be running

Everything resolves/registers `did:cid` via the node, and the transport uses DIDComm, so on the
node host (**flaxlap**) bring the stack up **with the DIDComm profile**:

```bash
cd ~/archon
COMPOSE_PROFILES=didcomm ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS=true docker compose up -d
```

From your machine, confirm the node is up and DIDComm is enabled (note: this is **Drawbridge
`:4222`**, which fronts the gatekeeper API, capabilities, and the `/didcomm` mount):

```bash
curl -s http://flaxlap.local:4222/api/v1/version        # {"version":"0.10.0",...}
curl -s http://flaxlap.local:4222/api/v1/capabilities   # want {"didcomm":true,...}
curl -s http://flaxlap.local:4222/didcomm/health        # {"ready":true}
```

## 1. Build (once per code change)

```bash
cd ~/Projects/personal/hearthold
npm install          # first time only
npx tsc --build
```

## 2. Fast path — automated end-to-end (proves the whole spine in ~1 min)

Runs against the live node in an isolated data dir (`.hearthold-e2e/`, never touches your real
`~/.hearthold`):

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass'
npm run e2e            # delegation handshake + witness→store→receipt over DIDComm
```

Expect two `PASS` blocks. Separately: `npm run e2e:delegation`, `npm run e2e:submission`, and
`npm run smoke:didcomm` (raw DIDComm round-trip).

## 3. Manual interactive test — two terminals

Uses **real identities** under `~/.hearthold`. Pick one passphrase; both agents read
`HEARTHOLD_PASSPHRASE` (separate wallets, so a shared value is fine for testing).

**Terminal B — Witness (get its DID first):**

```bash
cd ~/Projects/personal/hearthold
export HEARTHOLD_PASSPHRASE='choose-a-passphrase'
node packages/witness/dist/index.js init        # → copy the Witness did:cid
```

**Terminal A — Warden (init, delegate to that DID, serve):**

```bash
cd ~/Projects/personal/hearthold
export HEARTHOLD_PASSPHRASE='choose-a-passphrase'
node packages/warden/dist/index.js init                     # → copy the Warden did:cid (publishes its DIDComm endpoint)
node packages/warden/dist/index.js delegate <witness-did>   # records the delegation
node packages/warden/dist/index.js serve                    # polls the mailbox and replies; stays running
```

**Terminal B — submit observations (address the Warden by DID):**

```bash
export HEARTHOLD_WARDEN_DID=<warden-did>
node packages/witness/dist/index.js submit location "at the corner cafe"
node packages/witness/dist/index.js submit document "2025 tax return summary"
```

**Terminal A (Ctrl-C the server, or a third terminal) — inspect the vault:**

```bash
node packages/warden/dist/index.js vault
```

There is no `WARDEN_URL` or port: the Witness addresses the Warden by `did:cid` and the message
routes through the node's DIDComm relay. `witness accept <credDid>` is optional — the Warden
authorizes by the delegation it recorded; the Witness need not present it for submission.

## 4. What you should see (and what's not built yet)

- `witness submit` prints a receipt with an artefact id and a **sensitivity** the local model
  assigned (e.g. a tax document → `3` HIGH, a public tweet → `0` PUBLIC). Requires Ollama running
  with the model (`HEARTHOLD_CLASSIFIER_MODEL`, default `qwen3:8b`); if Ollama is down it fails safe
  to `4` SEALED. Test the classifier directly with `warden classify <kind> "<text>"`.
- `warden vault` lists each artefact as `[sensitivity] <kind> observed <ts>` with **ciphertext
  only** at rest (payloads are sealed in-band — nothing anchored on the registry).
- The **"prove" half isn't built yet**: an evidence request returns a *denied* error. The real
  evidence + step-up flow is step 5 / milestone S.
- Handy: `… warden … status` / `… witness … status` show identity + config; append `help` for the
  full verb list.

## 5. Command reference

| Warden | Witness |
|---|---|
| `init` — provision identity | `init` — provision identity |
| `status` — identity + config | `status` — identity + config |
| `delegate <witnessDid>` — issue + record delegation | `accept <credDid>` — accept delegation (optional) |
| `serve` — serve over DIDComm | `submit <kind> <text>` — seal + submit observation |
| `classify <kind> <text>` — test the local classifier | |
| `vault` — list stored artefacts | |

`<kind>` ∈ `event | location | activity | browsing | document`

## 6. Environment variables

| Var | Used by | Default | Notes |
|---|---|---|---|
| `HEARTHOLD_PASSPHRASE` | both | — | required; unlocks the wallet |
| `HEARTHOLD_NODE_URL` | both | `http://flaxlap.local:4222` | Archon node (Drawbridge); fronts gatekeeper + DIDComm |
| `HEARTHOLD_DATA_ROOT` | both | `~/.hearthold` | per-agent wallets + vault |
| `HEARTHOLD_REGISTRY` | both | `hyperswarm` | anchoring registry |
| `HEARTHOLD_WARDEN_DID` | Witness | — | required for `submit`; the Warden's `did:cid` |
| `HEARTHOLD_OLLAMA_URL` | Warden | `http://localhost:11434` | local model endpoint (on-device) |
| `HEARTHOLD_CLASSIFIER_MODEL` | Warden | `qwen3:8b` | local classifier model |
| `HEARTHOLD_CLASSIFIER` | Warden | `ollama` | set to `quarantine` to disable the model |

> The Warden classifies on-device via Ollama — run `ollama serve` with the model pulled
> (`ollama pull qwen3:8b`). No artefact content leaves the machine.

## 7. Reset / troubleshooting

- **`HEARTHOLD_PASSPHRASE is required`** → not exported in that terminal.
- **`HEARTHOLD_WARDEN_DID is required for submit`** → export it in the Witness terminal.
- **`recipient has no DIDCommMessaging endpoint`** → the Warden never published its endpoint. Run
  `warden init` (which publishes) or `warden publish` on the Warden, once the node's DIDComm is up.
- **submit hangs / times out** → the Warden published its endpoint (so the send succeeded and the
  submission is queued in the relay) but no `warden serve` is running to process it and reply.
  Start `warden serve`. Also check DIDComm is enabled (`/api/v1/capabilities`).
- **`Warden refused: no valid delegation`** → run `warden delegate <witness-did>` first.
- **`invalid ghash tag` / wallet won't open** → wrong passphrase for an existing wallet. Start
  clean with `rm -rf ~/.hearthold` (real identities) or `rm -rf .hearthold-e2e` (test identities).
