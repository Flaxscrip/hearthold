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

> Status: this is the decided transport. The current code uses a direct HTTP/Tailscale path behind
> the same protocol types; migration to DIDComm is in progress, via a `Transport` seam that keeps
> both interchangeable (HTTP retained as a simple LAN option).

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
