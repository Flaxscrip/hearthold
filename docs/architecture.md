# Hearthold — Architecture

## Components

```
┌─────────────────────────── HOME (trusted hardware) ───────────────────────────┐
│                                                                                │
│   Warden (home Keeper)                                                         │
│   ├─ Identity        did:cid, wallet @ ~/.hearthold/warden/                    │
│   ├─ Ingestion       connectors: witness submissions (v1), NAS/fs (P2)         │
│   ├─ Classifier      LOCAL model (Ollama) → sensitivity label + metadata       │
│   ├─ Vault store     encrypted artefacts at rest                               │
│   ├─ Index           vector + structured metadata (local)                      │
│   ├─ Security        sensitivity × authz tiers × disclosure (see security-model)│
│   └─ Prover          mints selective-disclosure VCs                            │
│                                                                                │
│   └─ DIDComm v2      mailbox transport — no notices, no registry footprint       │
└───────────────▲───────────────────────────────────────────┬──────────────────┘
        DIDComm v2 (authcrypt · sealed bodies)       │ evidence (VCs)
                │ submit · evidence · prove                  ▼
┌───────────────┴──────────────── WORLD (phone / browser / CLI) ─────────────────┐
│                                                                                │
│   Emissary (Companion)                                                          │
│   ├─ Identity        did:cid, wallet @ ~/.hearthold/emissary/                   │
│   ├─ Capture         local-only context (event/location/browsing)             │
│   ├─ Delegation      holds revocable HearthholdDelegation VC                   │
│   └─ Presenter       requests evidence, presents VCs to third parties         │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘

        Both resolve identities via Archon Gatekeeper @ flaxlap.local:4224
```

Beyond the home-bound pair, three more identities complete the system: the **Sovereign** (First Person,
held by the **Signet** app — decides, approves with proof-of-human, signs the Warden's policy), the
**Verifier** (a relying party that requests proofs), and the **Registry** (a TRQP trust registry over
Archon groups). All speak DIDComm v2 / TRQP; the subsystems they form are described below.

## Identities & custody

Each agent instantiates Keymaster **as a library** (not the node's keymaster HTTP service),
backed by its own `WalletJson` file. This gives wallet-per-actor custody and lets the Emissary
identity migrate to other devices via `backupId` / `recoverId`.

```ts
import Keymaster, { WalletJson } from '@didcid/keymaster';
import GatekeeperClient from '@didcid/gatekeeper/client';
import CipherNode from '@didcid/cipher/node';

const gatekeeper = await GatekeeperClient.create({ url: GATEKEEPER_URL });
const keymaster  = new Keymaster({
  passphrase,
  gatekeeper,
  wallet: new WalletJson('wallet.json', dataFolder),
  cipher: new CipherNode(),
});
```

## Actors & exclusive purposes

The three identities keep deliberately exclusive jobs — drawn from the PVM archetypes (Mage /
First Person / Swordsman):

| | does | never |
|---|---|---|
| **Emissary** (many, per device) — *Mage* | **interfaces with the world**: *sees in* (witnesses local context) **and** *projects out* (presents proofs, carries requests), carrying delegated authority and **no secrets** | is the authority, the subject of a claim, or the approver of a disclosure |
| **Sovereign** (one, the Signet) — *First Person* | **decides + approves + signs**: authorizes disclosures with proof-of-human, holds credentials as subject, signs the Warden's policy | witnesses routine context, or runs as an always-on server |
| **Warden** (one) — *Swordsman* | **protects + custodies + derives**: holds the sealed vault, classifies on-device, assembles/derives evidence | acts in the world, or holds the deciding secret |

**One Sovereign, many Emissaries.** A Witness DID is a *per-device session recorder* — each device
(phone, browser) gets its own. This is not optional: a shared Witness DID would mean the same key on
every device, with **mailbox contention** (the relay keys messages by recipient DID, so devices
would compete for replies), **endpoint conflicts** (last writer wins), and a blast radius the size
of your least-secure device. Per-device gives precise provenance (`witnessedBy` per artefact),
granular revocation, and scoped capability — a phone witnesses location, a browser witnesses
browsing. (`backupId`/`recoverId` *moves* an Emissary to a new device; it does not run one concurrently
on several.) The Warden already tracks *N* Emissaries (`DelegationStore` is a list); a **kind-scope**
refinement (reject a submission whose `kind` isn't in *that* Emissary's delegated `kinds`) makes the
per-device scope enforceable.

**Projection is an Emissary act; the authority behind it is the Sovereign's.** The Emissary is the
world-facing emissary that carries a proof out — but it carries *delegated* authority, not the
deciding secret. For a sensitive disclosure it **relays to the Signet**, the Sovereign approves with
proof-of-human and signs, and the Emissary projects the result. Low-stakes/pre-authorized projections
the Emissary may do alone under standing delegation. This matches §7.7 (the relaying agent carries, it
does not author or approve) and keeps the Signet an *occasional* authority, not a server.

> Status: **implemented.** `emissary serve` is the world-facing projector: a verifier addresses the
> Emissary, which relays the proof-request to the Sovereign over DIDComm; the Signet approves with
> proof-of-human and presents, and the Emissary carries the presentation back. The Emissary holds no
> deciding secret (it only carries — §7.7), and the Signet stays an *occasional* approver. The direct
> `sovereign serve` path remains for headless/standalone use. Tested live (`e2e:projector`, approve +
> decline). Verifier target: pass the **Emissary** DID (`verifier verify <witnessDid> …`).

## Trust relationship

```
Warden ──issues──► HearthholdDelegation VC ──► Emissary
   ▲                                              │
   └──────── challenge / response ◄───────────────┘   (per request, for CHALLENGE+ tiers)
```

The delegation is **scoped** (which claim-kinds the Emissary may request, expiry) and
**revocable** (Warden can revoke the credential, instantly de-authorizing the Emissary).

## Transport — DIDComm v2 (private, no registry footprint)

Emissary and Warden exchange messages over **Archon DIDComm v2** — *not* dmail (whose notices would
publish the relationship on the registry) and not a bespoke socket. The DIDComm send path writes
**nothing to the registry**, so an observer learns no sender↔recipient edges; the only party that
sees `(recipient DID, timing)` is the **relay**, which is the Sovereign's own node.

- **authcrypt = *who*.** Default authcrypt authenticates the sender DID at the transport layer
  (`receiveDidComm` → `sender`, `authenticated: true`). DID authentication is free, so the Warden no
  longer runs a challenge merely to prove DID control; it just checks it issued that DID an unrevoked
  delegation.
- **Repurposed challenge/response = *what*.** Challenge/response moves up to the *authorization*
  layer: the Warden puts the **purpose** (`txn`, claim, validity window) in a challenge; the
  Sovereign/Emissary **signed response** is a dated, DID-attributable approval (R1/R2/R5).
- **authcrypt is repudiable; evidence is signed.** authcrypt authenticates to the recipient but is
  deniable to third parties — fine for private transport. Anything that must survive as **portable
  evidence** (approvals, attestations) is an explicitly **signed** artefact, not an authcrypt message.
- **Payloads sealed in-band.** Observations are sealed to the Warden's key
  (`CipherNode.encryptMessage`) inside the DIDComm message; the relay never sees content and nothing
  is anchored.
- **Async + offline.** Store-and-forward mailbox (poll `receiveDidComm`); request/response correlates
  via `thid`. The Emissary can submit while the Warden is offline.

Each identity calls `publishDidComm()` once to advertise its endpoint. The protocol messages
(`WitnessSubmission`, `EvidenceRequest`/`EvidenceResponse`, …) are transport-agnostic and carried as
DIDComm message bodies.

> Status: **implemented.** The Emissary↔Warden flow runs over DIDComm v2 via the `Transport` seam
> (`core/transport.ts` → `DidCommTransport`). `warden serve` polls its mailbox and replies;
> `emissary submit` sends and correlates the receipt by `thid`. Tested live (`e2e:submission` +
> a two-process CLI run).

## Subsystems — credentials, trust registry, and the Game-of-42 bridge

Beyond the v1 witness→store→prove loop, three subsystems carry the trust-graph and delegation work
(full detail in [trust-graph-and-delegation.md](trust-graph-and-delegation.md)):

- **DTG credentials** (`core/dtg.ts`). The Decentralized Trust Graph set — VRC (relationship), VMC
  (membership), VIC (invitation), VPC (persona), VEC (endorsement/role), VWC (witness), and the RCard
  VDS — issued and verified natively on Archon (`did:cid`, VC 2.0). These are the edges and memberships
  of the trust graph.
- **Trust registry** (`core/trust-registry.ts`, `packages/registry`). A **ToIP TRQP v2.0** evaluator —
  `HttpTrustRegistry` (consume any remote registry) and `GroupTrustRegistry` (run one over Archon
  groups), authorizing per `(action, resource)`. *Outward* it decides which issuers a verifier trusts;
  *inward* it grades an Emissary's autonomy (the standing-delegation ceiling), so the projector relays to
  the Signet only above the cleared level. `verifyProof` consults it directly.
- **Game-of-42 bridge** (`core/game42.ts`). A byte-exact implementation of the agentprivacy Game-of-42
  canon (`VRC → κ → seal`) plus a City-Key projection: a sealed governance board (e.g. a guild) becomes
  a constellation node / soulbis City Key — the constellation *is* the trust registry, rendered
  visually (see [for the City of Mages](../demos/game-of-42/for-the-city-of-mages.md)).

## Data flow — witness→store→prove (v1)

1. **Observe** — Emissary captures an event `{ kind, observedAt, payload }`.
2. **Seal & submit** — Emissary seals the payload in-band to the Warden's key and `sendDidComm` a
   `WitnessSubmission`. authcrypt authenticates the Witness DID; no session handshake.
3. **Authorize** — Warden confirms it issued that Witness DID an unrevoked delegation scoped to the
   submission kind.
4. **Store & label** — Warden unseals locally, classifies, stores the (still-sealed) artefact,
   assigns a sensitivity label (default `SEALED` → classifier may relax), replies with a receipt.
5. **Index** — Warden embeds + indexes for retrieval *(next milestone)*.
6. **Request & step-up** — Emissary sends an `EvidenceRequest`. If the artefact's sensitivity demands
   it, the Warden issues a **purpose-bearing challenge**; the Sovereign (via the Signet) returns a
   signed response with a proof-of-human assertion *(next milestone)*.
7. **Decide & mint** — Warden runs the release decision; if cleared, returns a signed **evidence
   graph** (the attestation + provenance, with the signed approval as a node).
8. **Present & verify** — Emissary presents the evidence graph; a third party verifies it against the
   Warden's (and Sovereign's) DID.

## Module map

`packages/core` (shared by every front-end):

| Module | Responsibility |
|---|---|
| `config.ts` | Env-driven config (node URL, data dirs, registry, `sovereignDid`, classifier) |
| `keymaster.ts` | Node Keymaster factory (gatekeeper + WalletJson + CipherNode); retains the cipher |
| `identity.ts` | Create/load the Warden / Emissary / Sovereign / Verifier / Registry identities |
| `security.ts` | Sensitivity labels, authz tiers, clearance & release decision |
| `protocol.ts` | Wire types: submission, receipt, evidence, proof-request / proof-presentation, error |
| `transport.ts` | DIDComm v2 transport seam — `DidCommTransport` (`ready` / `request` / `serve`) |
| `payload.ts` | In-band seal/unseal to a DID's key (no anchoring) + content id |
| `auth.ts` | Challenge/response handshake primitives |
| `credentials.ts` | Mint / accept / revoke delegation & claim VCs |
| `schema.ts` | Register/persist schemas (did:cid) |
| `issued.ts` | `issued` evidence leaves — third-party VCs accepted into the vault |
| `prove.ts` | Prove flow — `requestProof` / `presentProof` / `verifyProof` (registry-aware) |
| `dtg.ts` | DTG credential set — VRC / VMC / VIC / VPC / VEC / VWC + RCard on Archon |
| `trust-registry.ts` | TRQP `TrustEvaluator` — `HttpTrustRegistry` + `GroupTrustRegistry` (Archon groups) |
| `game42.ts` | Game-of-42 byte-exact canon (VRC → κ → seal) + the City-Key projection |

Front-ends — each a thin CLI over `core`:

- **`packages/warden`** — custody: `serve` (DIDComm mailbox), classify, vault, delegation store.
- **`packages/emissary`** — Companion: `submit`, and `serve` (the world-facing projector relay).
- **`packages/sovereign`** — the principal / **Signet**: `accept`, `issue`, `serve` (proof-of-human-gated presentation).
- **`packages/verifier`** — relying party: `verify` (trusts an issuer DID and/or a trust registry).
- **`packages/registry`** — TRQP trust registry: `bind` / `grant` / `revoke` / `check` / `list` / `serve`.
