# Hearthold — Manual Launch & Test

How to launch and exercise what's built so far: the delegation handshake and the
witness→store→receipt loop over the HTTP/Tailscale transport. (The "prove" half — `/evidence` +
step-up — is not built yet; see [PLAN.md](PLAN.md).)

## 0. Prerequisite: the Archon node must be running

Everything below resolves/registers `did:cid` identities via the Gatekeeper, so the Archon stack
must be up on the node host (**flaxlap**):

```bash
cd ~/archon && docker compose up -d
```

From your machine, confirm it answers before proceeding:

```bash
curl -s http://flaxlap.local:4224/api/v1/version   # expect {"version":"0.9.0",...}
curl -s http://flaxlap.local:4224/api/v1/ready      # expect: true
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
npm run e2e            # delegation handshake + witness→store→receipt over HTTP
```

Expect two `PASS` blocks. Separately: `npm run e2e:delegation` and `npm run e2e:submission`.

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
node packages/warden/dist/index.js init
node packages/warden/dist/index.js delegate <witness-did>   # → copy the credential did:cid
node packages/warden/dist/index.js serve                    # stays running; binds 127.0.0.1:8787
```

**Terminal B — accept the delegation, then submit observations:**

```bash
export HEARTHOLD_WARDEN_URL=http://127.0.0.1:8787
node packages/witness/dist/index.js accept <credential-did>
node packages/witness/dist/index.js submit location "at the corner cafe"
node packages/witness/dist/index.js submit document "2025 tax return summary"
```

**Terminal A (Ctrl-C the server, or a third terminal) — inspect the vault:**

```bash
node packages/warden/dist/index.js vault
```

## 4. What you should see (and what's not built yet)

- `witness submit` prints a receipt with an artefact id and **`sensitivity: 4`** — everything
  quarantines to `SEALED` for now because the classifier is the fail-safe `QuarantineClassifier`.
  Real labels arrive when we wire **`qwen3:8b`** (step 4).
- `warden vault` lists each artefact as `[4] <kind> observed <ts>` with **ciphertext only** at rest
  (payloads are sealed in-band — nothing anchored on the registry).
- The **"prove" half isn't testable yet**: `POST /evidence` is a deliberate stub returning
  *denied*. The real evidence + step-up flow is step 5 / milestone S.
- Handy: `… warden … status` / `… witness … status` show identity + config; append `help` to
  either for the full verb list.

## 5. Command reference

| Warden | Witness |
|---|---|
| `init` — provision identity | `init` — provision identity |
| `status` — identity + config | `status` — identity + config |
| `delegate <witnessDid>` — issue delegation VC | `accept <credDid>` — accept delegation |
| `serve` — start HTTP service | `submit <kind> <text>` — seal + submit observation |
| `vault` — list stored artefacts | |

`<kind>` ∈ `event | location | activity | browsing | document`

## 6. Environment variables

| Var | Used by | Default | Notes |
|---|---|---|---|
| `HEARTHOLD_PASSPHRASE` | both | — | required; unlocks the wallet |
| `HEARTHOLD_GATEKEEPER_URL` | both | `http://flaxlap.local:4224` | Archon Gatekeeper |
| `HEARTHOLD_DATA_ROOT` | both | `~/.hearthold` | per-agent wallets + vault |
| `HEARTHOLD_REGISTRY` | both | `hyperswarm` | anchoring registry |
| `HEARTHOLD_WARDEN_BIND` | Warden | `127.0.0.1` | set to the Warden's tailnet IP (or `0.0.0.0`) |
| `HEARTHOLD_WARDEN_PORT` | Warden | `8787` | `serve` port |
| `HEARTHOLD_WARDEN_URL` | Witness | — | required for `submit`; e.g. `http://127.0.0.1:8787` |

## 7. Reset / troubleshooting

- **`HEARTHOLD_PASSPHRASE is required`** → not exported in that terminal.
- **`HEARTHOLD_WARDEN_URL is required for submit`** → export it in the Witness terminal.
- **connection refused on submit** → the Warden `serve` process isn't running, or the port differs.
- **`invalid ghash tag` / wallet won't open** → wrong passphrase for an existing wallet. Start
  clean with `rm -rf ~/.hearthold` (real identities) or `rm -rf .hearthold-e2e` (test identities).
- **Cross-Tailscale test:** run the Warden with `HEARTHOLD_WARDEN_BIND=<warden-tailnet-ip>` and set
  the Witness device's `HEARTHOLD_WARDEN_URL=http://<warden-tailnet-ip>:8787`.
