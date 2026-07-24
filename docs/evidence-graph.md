# Hearthold — The Evidence Graph (proof object)

When an Emissary proves something in the world, the Warden returns an **evidence graph**: a portable,
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
| `identity` | a `did:cid` — the Sovereign (subject), Warden (issuer), Emissary (observer) |
| `approval` | the Sovereign's signed response to a purpose-bearing challenge + proof-of-human (present for sensitive claims) |

**Edges (provenance):** `claim —derivedFrom→ evidence`, `evidence —witnessedBy→ identity(Emissary)`,
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
  a date window, by a named Emissary — not their contents.
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

## Trust classes of evidence (provenance leaves)

A roleplay (landlord asks for proof of FR residence) surfaced that **self-attested evidence does
not convince an external verifier** — the Warden vouching for the Sovereign's own data is "I say
so." So each provenance leaf is typed by **trust class**, and the verifier weighs it by *whom it
trusts*, not by the Warden alone:

| Class | What it is | Verifier trusts | Example |
|---|---|---|---|
| `issued` | a third-party Archon VC issued to the Sovereign's DID by an external issuer | the external **issuer's** DID | rental agreement, utility VC, RYT-500 cert |
| `witnessed` | a self-attested observation, represented as a VC the **Warden issues** (subject = Sovereign, holder = Emissary, `witnessedBy` = Witness DID) | the Sovereign's own infrastructure (weak alone) | photo at the Eiffel Tower, location pings |
| `attested` | a Warden-derived summary over sealed data, **disclosed as machine-derived** | the Warden + the disclosed `descriptionSource` | "142 pings in FR" |

Archon already supports `issued` (third-party VCs); Hearthold *adds* `witnessed`/`attested`
self-attested proofs — using the same `issueCredential`/`accept` flow, no new mechanism. **Proof
quality scales with how much is `issued`, and with whether the verifier is itself in the system**
(a verifier who also runs a Warden can verify inside a shared trust fabric).

Every leaf carries a **`descriptionSource`**: `issuer-asserted` | `sovereign-confirmed` |
`machine-derived`. Machine descriptions (from the local model) are fallible and are disclosed as
such; the Sovereign can override one, producing a `sovereign-confirmed` description that supersedes
it.

## Verifying an `issued` claim (built)

For "I hold a valid credential of type X from issuer Y", the proof is an **Archon
challenge/response presentation** — no new credential is minted:

- the **verifier** issues a challenge naming the schema it requires and the **issuers it trusts**
  (a fresh, verifier-bound, single-use challenge — this is the audience binding);
- the **Sovereign** (holder) presents the credential — the act of presenting *is* the
  external-disclosure approval;
- `verifyResponse` returns `match: true` plus the disclosed credential in `vps[]` — its
  `credentialSubject` claims **and** its `issuer` and `proof`. The verifier reads the claims and
  confirms the issuer is one it trusts.

So the verifier's trust rests on the **original issuer's** signature, surfaced directly by the
presentation. See `core/prove.ts` (`requestProof` / `presentProof` / `verifyProof`). Derived and
`witnessed` claims (a Warden-minted evidence graph over sealed data) build on top of this.

## Trust model

The Warden is the **assembler and custodian**: for `issued` leaves it verifies the *original
issuer's* signature and revocation status, then selectively discloses; for `witnessed`/`attested`
leaves it issues/derives and signs. A verifier's trust rests on the signature of **each leaf's
issuer** — the external party for `issued`, the Sovereign's own infrastructure for the rest — plus
its own decision to trust that issuer for the claim. Privacy comes from **derivation + selective
disclosure**. Disclosures are **audience-bound** to the verifier's DID (so a proof can't be
replayed to a different verifier, while the named verifier may retain its copy).

The Sovereign co-signature (the `approval` block) is the **signed response to a purpose-bearing
Archon challenge** the Warden issued for this `txn` — a dated, DID-attributable approval. Because
it is a signed artefact (not a repudiable transport message), it stands on its own as evidence and
is referenceable by DID from this graph.

## Producing a proof — flow (from roleplay)

1. **Canonical claim — authored by the Warden, confirmed by the Sovereign.** The Emissary relays the
   Sovereign's intent (NL or guided); the **Warden** normalizes it to a structured predicate
   (`{type, …}`) — it is the issuer that must evaluate the claim, so the agent does not get to shape
   the assertion (§7.7). The Sovereign confirms that canonical claim in the Signet approval preview.
2. **Retrieval — governed by Sovereign config.** Finding supporting evidence is easy for `issued`
   leaves (structured credentials, indexed by type/issuer) and harder for `witnessed` ones (the fact
   is inside sealed payloads → the classifier's **structured-extraction** pass, or decrypt-and-scan).
   How much structured metadata sits in the clear at rest is a **Sovereign-set Warden config**
   (signed per the control plane), not a hardcode.
3. **Claim evaluation.** For `issued` leaves the Warden verifies the original issuer's signature and
   revocation status. For `witnessed`/`attested` it reasons (local model) over the evidence — *do
   142 pings over six months constitute "residence"?* — a fallible, `machine-derived` judgement that
   is disclosed as such and that the Sovereign may override.
4. **Evidence resolution & review (incl. vision).** When a submission *references* an evidence DID
   (e.g. a Sovereign-created photo, a GPS asset), the Warden does not just read the citation as text
   — it **resolves the DID, fetches the asset, and reviews the content** with a local model: the text
   model for JSON/GPS, a local **vision** model for images (`qwen3` is text-only, so image review
   needs e.g. llava / qwen2-vl behind the classifier seam). The resolved-and-verified asset then
   enters the graph as a leaf, rather than as an unverified text mention.
   *Caveat:* if the asset is encrypted to the Sovereign, the Warden cannot open it — it can confirm
   the asset exists and who signed it, but content review requires a Warden-readable (or
   Sovereign-assisted) asset.

## Composite & multi-signer evidence (multi-sig, done differently)

Archon has no co-signed-single-credential (one object, N issuer signatures). The evidence graph
makes that unnecessary: instead of *one object with N signatures*, you **link N single-sig objects**
and the verifier checks each. This is strictly more flexible — every attestation is **independently
verifiable** *and* **selectively disclosable** (reveal a subset). The graph *is* the composition.

Archon already supports the verification side: a challenge's `credentials` is an **array**, so a
verifier can require *several* credentials from *several* issuers at once — *"a sphere VC **and** a
witnessed observation **and** a Sovereign-signed asset"* — satisfied by presenting several VPs. No
native multi-sig needed.

Two degrees of this:

- **Multi-agent (one person, several keys).** A Sovereign-signed asset (`create-asset-image`) cited
  by an Emissary-submitted observation is *two of the same person's keys* attesting to related objects.
  For *external* trust it is still self-attested (`witnessed` class), but it buys **separation of
  duties** (the field agent observes; the principal signs) and **tamper-evidence** (forging the
  bundle needs *both* keys, on two devices). This is the single-person warm-up.
- **Multi-party (different people's DIDs).** The same graph with leaves signed by *independent*
  parties — a notary, a witness, the subject — is the corroboration an external verifier actually
  wants (the third-party-attestation point, F6). This is where composite evidence becomes powerful.

So "multi-sig" in Hearthold is a graph of single-sig leaves, and Q-resolution (above) is how the
Warden turns a *referenced* Sovereign-signed asset into a *verified* leaf — realizing the
two-signature bundle a verifier can check.

## Decisions

Settled (validated by the residence + third-party-credential roleplays):

1. **Container encoding** — W3C VC 1.1 as the envelope (Keymaster-native), with SD-JWT-VC-style
   salted digests added when `SELECTIVE` is used.
2. **Leaf commitment** — two anchors: a Merkle root over *derived-claim digests* (enables
   `SELECTIVE` of a specific fact) **and** one over *artefact ciphertext ids* (proves "came from a
   stored sealed artefact").
3. **Provenance granularity** — group summary by default (counts / window / witness / root); reveal
   per-artefact leaves on request.
4. **Revocation** — Archon-native `revokeCredential`.
