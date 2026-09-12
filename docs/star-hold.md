# Star Hold — the City of Mages integration

Star Hold is Hearthold's integration with PrivacyMage's **Star / City-of-Mages / Verifiable Trust
Agent (VTA)** system. It is designed to one agreed seam (Flaxscrip/hearthold#90):

> **The Star presents; Hearthold verifies and enforces.**

The Star carries a **City Key** and presents it; Hearthold receives that presentation, verifies it,
and decides — through the Warden's release ladder — whether anything is disclosed or admitted. Neither
project reimplements the other. Two names, kept distinct at PrivacyMage's request: his **Hold
artefact** (`agentprivacy.star-hold/1`, the held collection of signed records + the City Key
commitment) is not the Hearthold **Star Hold module** that receives its presentations.

## Rails (enforced structurally, not by convention)

- **The Warden authors all consent text.** A requester's description of what it wants is input
  evidence, never the screen a human approves.
- **No subject identifier before approval.** First contact reveals *intent and context* only;
  key-loaded ≠ login.
- **Import ≠ control.** A valid, re-derived City Key proves *content*, not control. Admission waits
  on a bound-signer challenge (below).
- **Carrying ≠ accepting.** Verify under a suite you implement; **fail closed** on one you don't.
- **k-of-n is a policy predicate, not a reputation score.** Hearthold never emits a score, only a
  verifiable, decomposable evidence graph.

## Layer 1 — the κ primitive (shipped · `core/star-key.ts`)

The Star addresses a City Key by a content hash **κ**:

```
κ = "sha256:" + hex( SHA-256( UTF-8( canonicalCityJSON(key without top-level `kappa`) ) ) )
```

`canonicalCityJSON` is the **City canonicalization profile** (PrivacyMage's Law L5), ported verbatim
from his authoritative reference (`mitchuski/star` `sigil/index.html`): recursive key-sort, array
order preserved, no whitespace, `kappa` excluded from its own preimage, **unknown additive fields
preserved** in the preimage (SHAPE ≠ VIEW — a view change must not rewrite κ). This is **not** the
W3C JCS canonicalizer Hearthold uses for credential signatures; κ and the credential signature are
two separate layers and must never be conflated (#90).

| export | purpose |
|---|---|
| `StarCityKey` | City Key v1 type; unknown fields survive the round trip |
| `canonicalCityJSON` | the City profile (Law L5) |
| `deriveKappa` / `verifyCityKey` | re-derive κ; verdicts `authentic` \| `unnamed` \| `mismatch` |
| `derivePacketProof` / `packetsDigest` | Tracing-Protocol packet proof + Merkle root |

Conformance: `npm run e2e:star-key` — the profile, the verdicts, unknown-field / SHAPE≠VIEW
behaviour, and PrivacyMage's **published Merkle vector** (`sha256:07f2…83d1`), a cross-implementation
check that κ here matches the Star's origin byte-for-byte.

## Layer 2 — bound-signer verification & challenge (shipped · `core/star-vta.ts`)

Establishes that a presenter *controls* the Ed25519 signer bound to a κ, in two steps:

1. **`verifyVtaRecord`** — verifies PrivacyMage's `agentprivacy.vta/1` bearer attestation: an Ed25519
   signature (via `node:crypto`, no deps) over the canonical record fields
   `{kind, publicKeyHex, kappa, prior, at, walks, vrcs}` (defaults `prior→null`, `walks→0`,
   `vrcs→[]`), plus a `did:key` derivation (W3C multicodec `ed01`) and an optional claimed-`did`
   check. A **bearer attestation only** — deliberately not a delegation / context-grant / expiry
   receipt (#90).
2. **`issueBoundSignerChallenge` / `verifyBoundSignerChallenge`** — a Warden-minted nonce bound to
   κ + audience + expiry, signed by the record's bound key. A valid record alone is replayable; the
   live challenge proves control *now*.

The chain a gate relies on:

```
verified κ (L1) → VTA record binding an Ed25519 key to THAT κ → fresh challenge signed by that key
                ⇒ the presenter controls the identity bound to the κ
```

Conformance: `npm run e2e:star-vta` — did:key, record verify + negative cases (incl. a
key-≠-`publicKeyHex` forgery), and the challenge with anti-replay, expiry, and κ-mismatch.

> **Pending a fixture (to lock L2 to the origin):** PrivacyMage's `record.js` verifier is in a
> private repo, so two wire details are taken from the #90 spec and isolated (`vtaPreimage`, the
> decode helpers): (a) the canonical preimage uses the City profile; (b) `sig`/`publicKeyHex` are
> lowercase hex. A signed VTA-record fixture will lock both byte-for-byte, exactly as κ is locked to
> the published Merkle vector.

## Layer 3 — the Warden gate (design · the "First Gate")

The enforcement foot. **Not yet built** — held until the L2 wire is locked against a real fixture, so
the first working gate enforces on PrivacyMage's actual record, not on an assumption.

**Placement.** Presentation/transport on the **Emissary** (a `CapabilityModule` beside
`kb-web`/`doorman`/`oracle`); consent + release decision on the **Warden** (via `decideRelease()`).
A verifier-only path may report facts but can never replace the Warden's authorization decision —
a successful import, signature, or challenge never grants access by itself.

**Flow (one gate, e.g. KB admission or minting a scoped capability):**

1. Emissary receives the presentation: a City Key + an `agentprivacy.vta/1` record.
2. Warden verifies κ (L1). Fail → refuse, with the Warden's own consent/refusal text.
3. Warden issues a bound-signer challenge (L2) bound to κ + this audience + a short expiry.
4. Presenter signs; Warden verifies the challenge (L2) and **burns the nonce** (single-use store;
   fail-closed — an unknown or spent nonce is refused, indistinguishable from a bad response).
5. `decideRelease()` gates the one resource. Deny-by-default; sensitive outcomes step up to the
   Signet. **The Warden authors the consent text**; the requester's description is input evidence.
6. On admit, the Warden writes a **retained receipt** and returns it.

**The receipt** binds: the **pre-encounter κ** (per #90 — the receipt names the κ that existed
*before* this encounter; an authorized later fold sets `prior` and derives the next κ, avoiding a
receipt/key-hash cycle), the audience, the gate/resource, the challenge nonce, the expiry, and the
outcome. It carries **no subject identifier** created before approval.

**Publish path.** Any records Star Hold writes (VTA records, Hold/receipt commitments) go to the
**hyperswarm** registry — open, decentralized Archon infrastructure — not a proprietary service.

**Open items feeding Layer 3:**

- Lock the L2 VTA wire against a signed fixture from PrivacyMage.
- Add the **City Key PNG carrier** (the key travels in a PNG `tEXt` chunk) on the import path.
- Confirm the **"k registry"** contract (κ resolver / Archon registry / service; open vs.
  proprietary) — if it is a resolve-by-κ store, add an optional fetch-then-re-derive import path
  (safe by construction: κ is always re-derived, never trusted from the registry's word).
- Single-use nonce store + receipt store on the Warden side.

## Cross-suite credential interop (adjacent, not part of the gate)

Separately from κ, Archon `main` can now issue a **dual proof set** — `archon-ecdsa-jcs-2019`
(secp256k1) + the registered `eddsa-jcs-2022` (Ed25519, Multikey at `#key-assertion-1`) — once an
identity publishes its assertion key. This lets PrivacyMage's Ed25519-only verifier read Archon
credentials natively while Archon tooling verifies the secp256k1 proof in the same set. It is an
application/credential-layer change, **not** a consensus/hard-fork change to the operation protocol.
```

Reference: `packages/core/src/star-key.ts`, `packages/core/src/star-vta.ts`,
`scripts/e2e-star-key.ts`, `scripts/e2e-star-vta.ts`. Discussion: Flaxscrip/hearthold#90.
