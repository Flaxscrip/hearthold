# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hearthold gives a person a home-bound custodian agent for their private data history (the "7th
Capital") plus a world-facing companion that can request **verifiable evidence** from that history —
proving a fact without disclosing the data behind it. It is built on **Archon `did:cid`** identity
infrastructure (`@didcid/*` packages) and enforces one principle throughout: **separate the custodian
of data from the agent that acts in the world**, so neither alone can reconstruct the whole.

The design is expressed as separate agents, each its own `did:cid` with an independently-custodied
Keymaster wallet:

- **Warden** (`packages/warden`) — home Keeper / custodian & enforcer. Holds the full vault, classifies
  artefacts on-device, serves evidence, enforces the access-control policy. Control plane's *enforcer*.
- **Emissary** (`packages/emissary`) — world-facing companion. Observes local context, submits it home,
  later requests evidence and presents it to third parties. Holds a scoped, revocable delegation.
  **Formerly named "Witness"** — see the rename note below.
- **Sovereign** (`packages/sovereign`) — the principal, held by the **Signet** 2nd-factor app. Signs the
  Warden's policy (Ruleset) and co-signs sensitive disclosures with a proof-of-human assertion. Control
  plane's *authorizer*.
- **Verifier** (`packages/verifier`) — a third party that requests + checks proofs. Trust rests on the
  **issuer's** signature, never the Warden's word.

The Warden enforces; the Sovereign authorizes the rules; the Emissary acts under delegation.
Disclosure is **issuer-attested**: the Warden derives and signs a fact and carries provenance as
content hashes — Hearthold never emits a reputation score, only a verifiable, decomposable evidence
graph (`docs/evidence-graph.md`).

## Naming: the Witness → Emissary rename

The world-facing role was renamed **Witness → Emissary**. Newer code, docs, and package names use
`emissary`. Some older briefs, symbols, script names, and the top-level `README.md` still say "Witness"
— treat them as the same role. `packages/witness/` and `apps/witness/` are vestigial stubs (empty
`src`, no manifest); the live companion is `packages/emissary`. When adding code, use `emissary`.

## Build & test

Requires **Node ≥ 22**. TypeScript monorepo using **npm workspaces** + **TypeScript project references**
(`tsc --build`). ESM throughout (`"type": "module"`, `moduleResolution: NodeNext`); `strict` +
`noUncheckedIndexedAccess` + `verbatimModuleSyntax` are on, so imports need explicit `.js` extensions
and `import type` for type-only imports.

```bash
npm install            # first time only
npm run build          # tsc --build across all package references
npm run clean          # tsc --build --clean
```

There is **no test runner** — verification is via end-to-end scripts in `scripts/*.ts`, run directly
with `node --experimental-strip-types` (each `e2e:*` npm script builds first, then runs the `.ts`).
They exercise real flows against a **live Archon node** in isolated data dirs (e.g. `.hearthold-e2e/`,
never your real `~/.hearthold`).

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass'
npm run e2e                 # the spine: delegation handshake + emissary→store→receipt over DIDComm
npm run e2e:prove-didcomm   # full "prove" flow with Signet step-up
npm run e2e:cgpr            # CGPR / A2A gateway conformance suite
```

Run one script by its `package.json` script name (`npm run e2e:kb`, `npm run e2e:pairwise-grant`, …)
or invoke it directly after a build: `node --experimental-strip-types scripts/e2e-<name>.ts`.
`demo:*` scripts (`demo:cgpr`, `demo:vp-setup`) are runnable walkthroughs, not assertions.

### Prerequisite: a live Archon node with DIDComm

Nearly everything resolves/registers `did:cid` and routes over DIDComm through an Archon node
(**Drawbridge on `:4222`**, which fronts the gatekeeper API, capabilities, and the `/didcomm` mount —
*not* the raw gatekeeper on `:4224`). Bring the node up with the `didcomm` compose profile and confirm
`/didcomm/health` → `{"ready":true}` before running e2e scripts. The on-device classifier additionally
needs **Ollama** (`ollama serve` + the model in `HEARTHOLD_CLASSIFIER_MODEL`); set
`HEARTHOLD_CLASSIFIER=quarantine` to disable it and fail-safe everything to `SEALED`.

See `docs/manual-testing.md` for the full two-terminal manual walkthrough and the agent command
reference (`init` / `status` / `serve` / `delegate` / `submit` / `vault`).

## Agents address each other by DID, not URL

Agents communicate over **Archon DIDComm v2**, addressing each other by `did:cid` — there is *no*
`WARDEN_URL` or inter-agent port. The `Transport` seam lives in `packages/core/src/transport.ts`.
The only HTTP listeners are per-agent **control planes** (local UIs / RPC): Warden `4310`, Sovereign
`4311`, Emissary `4312`, and the Emissary KB **portal** `4313` (`HEARTHOLD_CONTROL_PORT` /
`HEARTHOLD_PORTAL_PORT` override). "submit hangs" almost always means no `warden serve` is draining the
mailbox — not a networking problem.

## Repository layout

```
packages/
  core/           @hearthold/core — the shared library, imported by every agent. One file per
                  concern; all re-exported from src/index.ts. Key seams:
                    identity.ts / keymaster.ts   did:cid provisioning, wallet
                    transport.ts                 DIDComm send/receive seam
                    protocol.ts / payload.ts     the Hearthold wire protocol; in-band sealing
                    security.ts                  sensitivity × authorization tiers × disclosure modes
                    evidence.ts / prove.ts       evidence graph mint + verify
                    ruleset.ts                   Sovereign-signed policy chains (signRuleset/verify)
                    pairwise.ts                  fresh pairwise DID per audience/counterparty (H1)
                    dtg.ts / trust-registry.ts   Trust Graph & Delegation, trust registry
                    kb.ts / recall.ts            Knowledge Base spaces + recall
                    single-use.ts                single-use txn / burn-on-reuse
  control-types/  shared control-plane DTOs (no deps)
  cgpr-types/     CGPR JSON Schemas (Consent-Gated Preference Requests), registered as Archon schemas
  a2a-gateway/    edge adapter translating A2A ⇄ internal DIDComm; holds no secrets, governed by Ruleset
  warden/ emissary/ sovereign/ verifier/ registry/   the runnable agents (bin in each package.json)
apps/             Vite browser front-ends: emissary, kb-portal, signet-approver, warden-console
scripts/          e2e-*.ts / demo-*.ts / roleplay-*.ts — run with node --experimental-strip-types
docs/             architecture, security-model, evidence-graph, PLAN.md, a2a-cgpr, kb-spaces, …
deploy/           systemd unit + nginx conf for the hosted KB Mage (see deploy/INSTALL.md)
```

Browser apps (`apps/*`) are separate Vite workspaces: `npm run dev` / `build` / `preview` from within
each app dir. They talk to a running agent's control-plane HTTP port.

## Architectural invariants (don't trade these away)

These come from the security model and the A2A/CGPR brief (`A2A-BRIEF.md`, `docs/security-model.md`,
`docs/a2a-cgpr.md`) and are enforced structurally, not by convention:

- **Deny-by-default release ladder.** Every disclosure crosses `decideRelease()`. Sensitive content
  triggers a step-up (PIN / Sovereign co-sign at the Signet). Put new release gating *inside* the
  release path, not in callers, so no future surface can forget it.
- **The Warden authors all consent text.** A requester's description of what it wants is *input
  evidence*, never the consent screen the human sees — requester-authored consent is a manipulation
  channel when the requester is an AI.
- **No subject identifier before approval.** No message in a CGPR flow (including denials) may carry the
  Sovereign DID, a pairwise DID, or any account handle before the human approves. The CGPR ticket schema
  has *no* subject field by construction.
- **Pairwise DID per audience/counterparty.** External grants and DTG edges are issued to a fresh
  pairwise DID (`core/pairwise.ts`); the pairwise→Sovereign linkage lives in one Warden-side store
  (`warden/pairwise-store.ts`) and is excluded from every evidence graph and summary. Reusing a stable
  DID is refused unless the active Ruleset carries a signed exception for that audience.
- **A2A only at the edge.** No A2A types leak into `@hearthold/core`; internally everything stays DIDComm
  v2 + the Hearthold wire protocol. The gateway is a "Mage": it holds no secrets and can lie about
  availability but never about content (verifiers check the issuer's signature, not the gateway's word).
- **On-device classification.** Artefact content never leaves the machine for classification; the
  classifier fails safe to `SEALED` when the local model is unavailable.

## Local state & secrets

Per-agent wallets, the vault, and indexes live under `HEARTHOLD_DATA_ROOT` (default `~/.hearthold`) and
are gitignored (`.hearthold/`, `*.wallet.json`, `data/`). Every agent process unlocks its wallet with
`HEARTHOLD_PASSPHRASE` (separate wallets, so a shared dev value is fine). Copy `.env.example` → `.env`
(gitignored). Never commit wallet/vault state.
