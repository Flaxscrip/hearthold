# Hearthold apps — the demo GUIs

Three browser apps, one per world-facing actor, so their **boundaries** are exercised for real:

| App | Actor (PVM) | Vite port | Control daemon | Daemon port |
|---|---|---|---|---|
| **warden-console** | Warden — Swordsman | 5173 | `warden control` | 4310 |
| **signet-approver** | Sovereign — First Person | 5174 | `sovereign control` | 4311 |
| **witness** | Witness — Mage | 5175 | `witness control` | 4312 |

## How it fits together

Each app is a **thin client**: a Vite/React front-end that drives its agent over a small localhost
control API (`GET /api/snapshot`, `POST /api/…`) plus a Server-Sent-Events stream (`GET /api/events`)
for live updates. The **real Keymaster wallet and DIDComm loop stay in the Node daemon** — the browser
never touches Keymaster, so there is no Buffer/crypto polyfill and no key material in the page. The
three daemons are three real agents that speak DIDComm to each other exactly as the CLIs do.

Shared wire types live in `@hearthold/control-types`; the `node:http` server + SSE helper is
`core/control-server.ts`. Each app is self-contained (its own `api.ts`, `ui.tsx`, `styles.css`).

```
browser app ──HTTP/SSE──► agent control daemon ──DIDComm v2──► other agents ──► Archon node
 (presentation)            (real Keymaster + mailbox)
```

> The control API binds to `127.0.0.1` and is unauthenticated — it is a **local dev / single-machine**
> control plane. Do not expose it beyond localhost/your tailnet.

## Prerequisites

- The Archon node up at `HEARTHOLD_NODE_URL` (default `http://flaxlap.local:4222`) with DIDComm enabled.
- Ollama running for real classification (optional — set `HEARTHOLD_CLASSIFIER=quarantine` to skip it).
- Build the daemons once: `npm install && npm run build` at the repo root. Rebuild after daemon edits.
  The apps hot-reload on their own.

Each daemon needs `HEARTHOLD_PASSPHRASE` for its wallet (same wallets the CLIs use, under
`~/.hearthold/<role>`). Override the daemon URL an app targets with `VITE_CONTROL_URL`.

## Run one app

**Warden Console** — the sealed vault, delegations, and classifier, made visible:
```bash
# terminal 1
HEARTHOLD_PASSPHRASE=… npm run warden -- control
# terminal 2
cd apps/warden-console && npm run dev      # → http://localhost:5173
```

**Signet Approver** — approve/deny each disclosure with a PIN (proof-of-human):
```bash
HEARTHOLD_PASSPHRASE=… HEARTHOLD_SIGNET_PIN=1234 npm run sovereign -- control
cd apps/signet-approver && npm run dev      # → http://localhost:5174
```

**Witness** — capture observations and (optionally) project proofs:
```bash
HEARTHOLD_PASSPHRASE=… HEARTHOLD_WARDEN_DID=did:cid:… \
  HEARTHOLD_SOVEREIGN_DID=did:cid:…  npm run witness -- control    # sovereign DID optional (projector)
cd apps/witness && npm run dev              # → http://localhost:5175
```

## The full three-app demo

1. Start all three daemons (get each DID from its `… control` banner or `GET /api/status`).
2. In the **Warden Console**, delegate the Witness (paste its DID → *Issue delegation*).
3. In the **Witness** app, witness an observation → it seals to the Warden and submits. Watch it appear
   **live** in the Warden Console vault with its sensitivity chip, and the Witness receipt flip
   `submitted → stored`.
4. Run the prove flow (a verifier requests a disclosure via the Witness projector). The **Signet
   Approver** shows the pending request → approve with your PIN → the Witness *Projections* panel
   records the carried proof. Deny, and the verifier is refused.
