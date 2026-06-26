# Hearthold — The Evidence Graph (proof object)

When a Witness proves something in the world, the Warden returns an **evidence graph**: a portable,
signed, decomposable object a relying party can verify on its own. It is the format of the "prove"
half of the loop (step 5). This document specifies its exact shape in terms of `did:cid`
identities, W3C Verifiable Credentials, signatures, and content hashes.

## Properties

- **Portable** — a self-contained object; verifiable offline against issuer DIDs.
- **Issuer-attested** — the Warden holds the evidence, derives the fact, and signs it. The verifier
  trusts that signature as it would any credential issuer.
- **Decomposable** — the claim links to the evidence that supports it, with provenance and time.
- **Selectively disclosed** — by default only the derived fact + a hash-anchored summary of support
  crosses the boundary; underlying claims can be revealed individually on request.
- **Never a score** — no sovereignty tier, reputation number, or ranking is ever computed or
  emitted. Only verifiable claims and their provenance.

## Graph model

A small typed graph. **Nodes:**

| Node | Meaning |
|---|---|
| `claim` | the derived fact being proven ("resided in FR during 2026-H1") |
| `evidence` | a group of supporting artefacts, summarized + hash-committed |
| `identity` | a `did:cid` — the Sovereign (subject), Warden (issuer), Witness (observer) |
| `approval` | the Sovereign's signed response to a purpose-bearing challenge + proof-of-human (present for sensitive claims) |

**Edges (provenance):** `claim —derivedFrom→ evidence`, `evidence —witnessedBy→ identity(Witness)`,
`claim —issuedBy→ identity(Warden)`, `claim —about→ identity(Sovereign)`,
`claim —approvedBy→ approval`.

## Concrete encoding (W3C VC 1.1, Archon-native)

The object is a Verifiable Credential issued by the Warden via Keymaster. It uses standard VC
fields — `evidence`, `termsOfUse`, `credentialStatus`, `proof`. Hearthold-specific structure lives
inside `evidence[]` and `approval`.

```jsonc
{
  "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://hearthold.dev/2026/evidence/v1"
  ],
  "type": ["VerifiableCredential", "HearthholdAttestation"],

  // Binding & freshness (R1)
  "id": "urn:hearthold:txn:7b21f0…e0",        // == txn; unique; single-use
  "issuer": "did:cid:<warden>",
  "issuanceDate": "2026-06-26T14:00:00Z",
  "expirationDate": "2026-06-26T14:05:00Z",   // short-lived

  // The claim node
  "credentialSubject": {
    "id": "did:cid:<sovereign>",              // the claim is about the Sovereign
    "claim": "Resided in FR during 2026-H1",  // human-readable
    "structured": { "type": "residence", "country": "FR", "period": "2026-H1" }
  },

  // Provenance subgraph — W3C-standard `evidence` field
  "evidence": [
    {
      "id": "urn:hearthold:ev:1",
      "type": ["HearthholdArtefactGroup"],
      "kind": "location",
      "observedFrom": "2026-01-03",
      "observedTo": "2026-06-28",
      "count": 142,                            // 142 supporting observations
      "witnessedBy": "did:cid:<witness>",      // who observed them
      "commitment": {                          // hash anchor over the group
        "alg": "sha256",
        "merkleRoot": "b94d…7c",               // root over per-artefact claim digests
        "artefactIds": "merkle:…"              // (optional) over vault ciphertext hashes
      },
      "disclosure": "summary"                  // revealed: counts/window/witness/root — not contents
    }
  ],

  // R1 single-use / scope (standard field)
  "termsOfUse": [{ "type": "HearthholdSingleUse", "txn": "7b21f0…e0" }],

  // R5 — present for HIGH/SEALED disclosures
  "approval": {
    "approver": "did:cid:<sovereign>",
    "txn": "7b21f0…e0",
    "humanProof": { "method": "face-liveness", "level": 3,
                    "at": "2026-06-26T14:00:01Z", "evidenceDigest": "sha256:…" },
    "proof": {                                 // Sovereign signs (id, claim, evidence root, humanProof)
      "type": "EcdsaSecp256k1Signature2019",
      "verificationMethod": "did:cid:<sovereign>#key-1",
      "proofValue": "…"
    }
  },

  // Revocation (Archon-native)
  "credentialStatus": { "type": "ArchonRevocation", "id": "did:cid:<warden>/revocations" },

  // Warden signs the whole object
  "proof": {
    "type": "EcdsaSecp256k1Signature2019",
    "created": "2026-06-26T14:00:00Z",
    "verificationMethod": "did:cid:<warden>#key-1",
    "proofPurpose": "assertionMethod",
    "proofValue": "…"
  }
}
```

## Content-hash anchoring

Each vault artefact already has a stable id = `sha256(ciphertext)` (`core/payload.ts:contentId`).
For an evidence group the Warden builds a **Merkle tree** whose leaves are *salted digests of the
derived per-artefact claims* (e.g. `sha256(salt || "in FR on 2026-03-04")`), and publishes only the
**root** in the `commitment`. This commits the Warden to a specific set of underlying facts without
revealing them, and lets it later reveal any single leaf + Merkle path on request.

## Selective disclosure

- **`ATTESTATION` (default).** Only the derived `claim` + the summarized, root-committed `evidence`
  group cross the boundary. The verifier sees *that* 142 witnessed observations back the claim, over
  a date window, by a named Witness — not their contents.
- **`SELECTIVE`.** To substantiate further, the holder reveals chosen leaves: each as
  `{ value, salt, merklePath }`. The verifier recomputes `sha256(salt || value)` and checks the path
  against the signed `merkleRoot`. This is SD-JWT-VC salted-digest disclosure.
- **`REDACTED` / `FULL`.** The artefact with fields removed, or whole — high tiers only.

## Verification procedure (what a relying party does)

1. **Signature & issuer.** Verify `proof` over the canonical object; resolve `issuer` (`did:cid`);
   confirm it is the Warden you expect.
2. **Freshness & uniqueness.** Check `issuanceDate`/`expirationDate`; ensure `id`/`txn` is unused
   (single-use).
3. **Revocation.** Check `credentialStatus` against the Warden's revocation list.
4. **Approval (if present).** Verify the Sovereign `approval.proof`; confirm `humanProof.level`
   meets your bar for the claim's sensitivity.
5. **Provenance.** Read the `evidence` groups: counts, window, witness DID, commitment root. If the
   holder supplied `SELECTIVE` leaves, recompute digests and check Merkle paths against the root.
6. **Decide.** Do you trust this Warden/Sovereign as issuer for this claim? If yes, accept.

## Trust model

The Warden is the **issuer**: it derives and signs the fact, the Sovereign co-signs the sensitive
ones, and provenance is hash-anchored to witnessed artefacts. A verifier's trust rests on the
issuer's signature — exactly as with any credential — plus its own decision to trust that issuer
for the claim. Privacy comes from **derivation + selective disclosure**: revealing the fact and a
hash-committed summary of its support, rather than the underlying data.

The Sovereign co-signature (the `approval` block) is the **signed response to a purpose-bearing
Archon challenge** the Warden issued for this `txn` — a dated, DID-attributable approval. Because
it is a signed artefact (not a repudiable transport message), it stands on its own as evidence and
is referenceable by DID from this graph.

## Decisions

Settled (to be validated by a scenario roleplay before implementation):

1. **Container encoding** — W3C VC 1.1 as the envelope (Keymaster-native), with SD-JWT-VC-style
   salted digests added when `SELECTIVE` is used.
2. **Leaf commitment** — two anchors: a Merkle root over *derived-claim digests* (enables
   `SELECTIVE` of a specific fact) **and** one over *artefact ciphertext ids* (proves "came from a
   stored sealed artefact").
3. **Provenance granularity** — group summary by default (counts / window / witness / root); reveal
   per-artefact leaves on request.
4. **Revocation** — Archon-native `revokeCredential`.
