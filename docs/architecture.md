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
│   └─ HTTP service    bound to a private (Tailscale) interface — no notices       │
└───────────────▲───────────────────────────────────────────┬──────────────────┘
        private HTTP over Tailscale (sealed bodies)  │ evidence (VCs)
                │ session · submit · evidence                ▼
┌───────────────┴──────────────── WORLD (phone / browser / CLI) ─────────────────┐
│                                                                                │
│   Witness (Companion)                                                          │
│   ├─ Identity        did:cid, wallet @ ~/.hearthold/witness/                   │
│   ├─ Capture         local-only context (event/location/browsing)             │
│   ├─ Delegation      holds revocable HearthholdDelegation VC                   │
│   └─ Presenter       requests evidence, presents VCs to third parties         │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘

        Both resolve identities via Archon Gatekeeper @ flaxlap.local:4224
```

## Identities & custody

Each agent instantiates Keymaster **as a library** (not the node's keymaster HTTP service),
backed by its own `WalletJson` file. This gives wallet-per-actor custody and lets the Witness
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
| **Witness** (many, per device) — *Mage* | **interfaces with the world**: *sees in* (witnesses local context) **and** *projects out* (presents proofs, carries requests), carrying delegated authority and **no secrets** | is the authority, the subject of a claim, or the approver of a disclosure |
| **Sovereign** (one, the Signet) — *First Person* | **decides + approves + signs**: authorizes disclosures with proof-of-human, holds credentials as subject, signs the Warden's policy | witnesses routine context, or runs as an always-on server |
| **Warden** (one) — *Swordsman* | **protects + custodies + derives**: holds the sealed vault, classifies on-device, assembles/derives evidence | acts in the world, or holds the deciding secret |

**One Sovereign, many Witnesses.** A Witness DID is a *per-device session recorder* — each device
(phone, browser) gets its own. This is not optional: a shared Witness DID would mean the same key on
every device, with **mailbox contention** (the relay keys messages by recipient DID, so devices
would compete for replies), **endpoint conflicts** (last writer wins), and a blast radius the size
of your least-secure device. Per-device gives precise provenance (`witnessedBy` per artefact),
granular revocation, and scoped capability — a phone witnesses location, a browser witnesses
browsing. (`backupId`/`recoverId` *moves* a Witness to a new device; it does not run one concurrently
on several.) The Warden already tracks *N* Witnesses (`DelegationStore` is a list); a **kind-scope**
refinement (reject a submission whose `kind` isn't in *that* Witness's delegated `kinds`) makes the
per-device scope enforceable.

**Projection is a Witness act; the authority behind it is the Sovereign's.** The Witness is the
world-facing emissary that carries a proof out — but it carries *delegated* authority, not the
deciding secret. For a sensitive disclosure it **relays to the Signet**, the Sovereign approves with
proof-of-human and signs, and the Witness projects the result. Low-stakes/pre-authorized projections
the Witness may do alone under standing delegation. This matches §7.7 (the relaying agent carries, it
does not author or approve) and keeps the Signet an *occasional* authority, not a server.

> Status: the current build simplifies this — `sovereign serve` presents proofs directly. Moving
> presentation to a **Witness that relays to the Signet for approval** is a planned refactor (see
> [PLAN.md](PLAN.md)); it is the PVM-faithful and operationally correct shape.

## Trust relationship

```
Warden ──issues──► HearthholdDelegation VC ──► Witness
   ▲                                              │
   └──────── challenge / response ◄───────────────┘   (per request, for CHALLENGE+ tiers)
```

The delegation is **scoped** (which claim-kinds the Witness may request, expiry) and
**revocable** (Warden can revoke the credential, instantly de-authorizing the Witness).

## Transport — DIDComm v2 (private, no registry footprint)

Witness and Warden exchange messages over **Archon DIDComm v2** — *not* dmail (whose notices would
publish the relationship on the registry) and not a bespoke socket. The DIDComm send path writes
**nothing to the registry**, so an observer learns no sender↔recipient edges; the only party that
sees `(recipient DID, timing)` is the **relay**, which is the Sovereign's own node.

- **authcrypt = *who*.** Default authcrypt authenticates the sender DID at the transport layer
  (`receiveDidComm` → `sender`, `authenticated: true`). DID authentication is free, so the Warden no
  longer runs a challenge merely to prove DID control; it just checks it issued that DID an unrevoked
  delegation.
- **Repurposed challenge/response = *what*.** Challenge/response moves up to the *authorization*
  layer: the Warden puts the **purpose** (`txn`, claim, validity window) in a challenge; the
  Sovereign/Witness **signed response** is a dated, DID-attributable approval (R1/R2/R5).
- **authcrypt is repudiable; evidence is signed.** authcrypt authenticates to the recipient but is
  deniable to third parties — fine for private transport. Anything that must survive as **portable
  evidence** (approvals, attestations) is an explicitly **signed** artefact, not an authcrypt message.
- **Payloads sealed in-band.** Observations are sealed to the Warden's key
  (`CipherNode.encryptMessage`) inside the DIDComm message; the relay never sees content and nothing
  is anchored.
- **Async + offline.** Store-and-forward mailbox (poll `receiveDidComm`); request/response correlates
  via `thid`. The Witness can submit while the Warden is offline.

Each identity calls `publishDidComm()` once to advertise its endpoint. The protocol messages
(`WitnessSubmission`, `EvidenceRequest`/`EvidenceResponse`, …) are transport-agnostic and carried as
DIDComm message bodies.

> Status: **implemented.** The Witness↔Warden flow runs over DIDComm v2 via the `Transport` seam
> (`core/transport.ts` → `DidCommTransport`). `warden serve` polls its mailbox and replies;
> `witness submit` sends and correlates the receipt by `thid`. Tested live (`e2e:submission` +
> a two-process CLI run).

## Data flow — witness→store→prove (v1)

1. **Observe** — Witness captures an event `{ kind, observedAt, payload }`.
2. **Seal & submit** — Witness seals the payload in-band to the Warden's key and `sendDidComm` a
   `WitnessSubmission`. authcrypt authenticates the Witness DID; no session handshake.
3. **Authorize** — Warden confirms it issued that Witness DID an unrevoked delegation scoped to the
   submission kind.
4. **Store & label** — Warden unseals locally, classifies, stores the (still-sealed) artefact,
   assigns a sensitivity label (default `SEALED` → classifier may relax), replies with a receipt.
5. **Index** — Warden embeds + indexes for retrieval *(next milestone)*.
6. **Request & step-up** — Witness sends an `EvidenceRequest`. If the artefact's sensitivity demands
   it, the Warden issues a **purpose-bearing challenge**; the Sovereign (via the Signet) returns a
   signed response with a proof-of-human assertion *(next milestone)*.
7. **Decide & mint** — Warden runs the release decision; if cleared, returns a signed **evidence
   graph** (the attestation + provenance, with the signed approval as a node).
8. **Present & verify** — Witness presents the evidence graph; a third party verifies it against the
   Warden's (and Sovereign's) DID.

## Module map

`packages/core` (shared by every front-end):

| Module | Responsibility |
|---|---|
| `config.ts` | Env-driven config (gatekeeper URL, data dirs, registry, bind/port, warden URL) |
| `keymaster.ts` | Node Keymaster factory (gatekeeper + WalletJson + CipherNode); retains the cipher |
| `identity.ts` | Create/load Warden & Witness identities |
| `security.ts` | Sensitivity labels, authz tiers, clearance & release decision |
| `protocol.ts` | Wire types: submission, receipt, session, evidence, step-up |
| `credentials.ts` | Mint/verify delegation & attestation VCs |
| `schema.ts` | Register/persist the delegation schema (did:cid) |
| `auth.ts` | Challenge/response handshake (create / respond / verify) |
| `payload.ts` | In-band seal/unseal to a DID's key (no anchoring) + content id |
| `http.ts` | Endpoint paths + fetch helpers |
| `client.ts` | `WardenClient` — Witness-side: connect, submit, request evidence (+ step-up) |

`packages/warden`: `server.ts` (HTTP service + sessions), `service.ts` (unseal → classify →
store → receipt), `classifier.ts` (local-model seam), `store.ts` (vault).
`packages/witness`: CLI over `WardenClient`.
