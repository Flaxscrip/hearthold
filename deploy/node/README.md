# `deploy/node` — Aegis Sovereign node deployment

Self-contained tooling to stand up an **egress-isolated Archon Sovereign node** — the personal, air-gapped kind.
The `pi-lean` profile targets a Raspberry Pi 5 (8 GB). Separate from `../` (the hosted KB-Mage systemd services +
`sandbox`): two distinct deployment targets living as siblings.

**Base:** node substrate = [`archetech/archon` v0.11.0](https://github.com/archetech/archon) · custodian = this repo (`@hearthold/*`).

## Start here

| you are… | run |
|---|---|
| a new Sovereign on a fresh Pi / box | **`aegis-install.sh`** — interactive: preflight → swap → deps → fetch → build → onboard → launch → verify |
| bringing it up by hand | `setup-node.sh` → `create-internal-network.sh` → `docker compose up` → `hearthold-up.sh` |
| operating a running node | `operator/aegis status` · `operator/aegis-wallet` · `operator/aegis-mcp` |
| installing offline / air-gapped | `offline/pack-offline-bundle.sh` on a connected box → carry → `offline/load-offline-bundle.sh` on the node |

## Who calls whom

```
aegis-install.sh                one-shot installer; orchestrates everything below (self-contained bash onboarding)
├─ create-internal-network.sh   the sealed, internal:true Docker network (no egress path)
├─ setup-node.sh                 mints the node .env (per-install secrets + isolation defaults) — operates on $ARCHON_DIR
│    └─ topology/pi-lean.env     the 8 GB profile deltas applied over .env (see PI-LEAN.md)
├─ docker compose up             the archon node on the resolved COMPOSE_PROFILES
├─ hearthold-up.sh               the custodian control plane (Warden / Signet / Emissary consoles)
└─ family/provision-node-family  optional: AI-agent identities parented under this node's Sovereign
```

## Layout

- **`operator/`** — the human operator CLI: `aegis` (status/table/signet/config/model), `aegis-wallet` (in-network
  wallet ops, gatekeeper never exposed), `aegis-mcp` (bound agent-Sovereign MCP). Client-safe; see `operator/README.md`.
- **`topology/`** — docker-compose overlays (control plane, agent-wardens, demo-Table, sealed/dmz) + helpers
  (`tcp-forward.mjs`, `table-gateway.mjs`) + **`pi-lean.env`**.
- **`family/`** — `provision-node-family` — creates the AI-agent identities under the node Sovereign (parent DID
  read from the environment; see `EXPECTED_PARENT_DID`).
- **`offline/`** — air-gap bundle: pack the built image + assets on a connected box, `docker load` on the node.
- **`PI-LEAN.md`** — the 8 GB profile spec: drops the drawbridge/Lightning/Tor bundle, passes cards via the
  standalone `didcomm` relay (`:4236`). **`ENVIRONMENT.md`** / **`SANDBOX-PROFILE.md`** — the isolation model.
- **`install.sh`** — the legacy VPS bootstrap (installs deps + Claude Code + the noderunner skill); `aegis-install.sh`
  is the self-contained successor.

## Isolation, always
Client tools reach daemons only via host loopback bridges; `aegis-wallet`/`aegis-mcp` run *in* the sealed net but
never publish the gatekeeper. `aegis status` proves egress fails (`ENETUNREACH`, IPFS peers 0) on every check.
