# Hearthold ↔ AgentPrivacy skill garden — integration proposal

*Draft material for GenitriX to relay to PrivacyMage/Mitchell. Grounds the "Skills of the AgentPrivacy
Universe" garden ([skills.agentprivacy.ai](https://skills.agentprivacy.ai/)) against Hearthold's shipped
identity + attestation layer. Nothing here is sent from Hearthold directly — it is a proposal for the
First Person's channel.*

> **Status:** proposal (plays), schema reconciled 2026-08-26 against the public snapshot of
> [skills.agentprivacy.ai](https://skills.agentprivacy.ai/). The **publish spec is now confirmed** — a
> `catalog.json` at `assets/skillsync/catalog.json`, packets as *card ≤280 · brief ≤1200 · sha256 body
> hash*, registered via `POST /garden {handle, url, note}`; the Librarian fetches + verifies (✓) at the
> door and chain-seals the entry. The only part still *proposed* is the per-skill JSON field naming
> (`{name, card, brief, bodyHash}` below) — the snapshot shows the packet spec and card/brief text, not the
> raw object keys. Companion: [`privacy-toolkit.md`](privacy-toolkit.md).

## The shape of the match

The skill garden and Hearthold are the same universe approached from two sides. The garden already reaches
for properties Hearthold ships as primitives:

| Garden concept | Hearthold primitive it maps to |
|---|---|
| **chain-sealed** entry / **attested run** | issuer-attested **VC** signed by a `did:cid` — a real signature, not the Librarian's word |
| `catalog.json` + **sha256 body hash** | content-addressing — the same "re-derive, never trust by name" as `did:cid` |
| **the Librarian** (fetch, verify ✓, standing tiers 🌰 seedling 0+ · 🌱 rooted 6+ · 🌳 grove 18+) | a **ToIP TRQP** trust registry (outward issuer-trust + inward standing) |
| **leaderboard** edges — discovered 1 · adopted 3 · attested-run 7 · **constellation contributed 2** · **constellation walked by another 5** | **DTG** trust-graph credentials (VRC/VMC/VIC/VEC) — edges minted by signatures; the two *constellation* edges are relationship endorsements (VEC/VMC) |
| **the Librarian's Desk** chain head over typed entries (publish · runtime · constellation · counsel · guide · garden · attest · name) + per-type digests | a Merkle-committed **status/log** — the same "commitment lets any member check the cloud told the truth" as our evidence-graph roots |
| **Counsel** (attributed, weighed-not-obeyed) | Archon challenge/response attribution + the AgentGate consent model |
| **loadout decks** = **constellations** you "walk" (briefs first, bodies on task-fire) | the Fold's census/sample + Hearthold recall's load-on-demand |
| four **kinds** (skill · persona · pattern · plugin) × categories | orthogonal to our roles — a Hearthold *capability module* publishes as a **skill**; see the collision note below |

The one-line thesis to offer: **the garden's "chain-seal" is exactly what Hearthold's issuer-attested
signature layer provides cryptographically.** A garden entry that is "attested" by the Librarian's record
is trust-on-the-Librarian; the same entry carried as a Warden- or author-signed VC is trust-on-the-issuer,
verifiable offline by anyone, no Librarian required.

## Vocabulary hygiene — collisions and one resonance (read before relaying)

The garden and Archon/Hearthold independently reuse several names. Flag these when relaying so the two sides
don't talk past each other:

- **"Gatekeeper".** In the garden, a **persona** — *personhood verification / Sybil-resistance* (∃! one
  human ↔ one credential, biometric-hash→nullifier). In Archon it is **infrastructure** — the DID resolver
  behind Drawbridge. Same word, opposite layer. (The garden's Gatekeeper concept actually maps to
  Hearthold's *proof-of-human co-sign* at the Signet, not to Archon's gatekeeper.)
- **"Herald".** In the garden, an *information-commons / media-plurality* persona. In Archon, the **Name
  Service** (`archon.social`). Unrelated; disambiguate explicitly.
- **"Emissary" — the one real resonance, not a collision.** The garden's **Master Emissary** pattern is
  McGilchrist's Master/Emissary (the emissary that forgets it serves the master). Hearthold's
  **Warden ⊥ Emissary** split is the same shape drawn as an architecture: the world-facing Emissary acts
  under a scoped delegation and must never become the master — the Warden (custodian) stays the reference
  monitor. Worth naming as *convergence*, not borrowing: the split keeps surfacing on its own. Their
  dual-agent poles (Soulbae = mage/delegation ⊥ Soulbis = swordsman/enforcement, held apart by the
  Horizon Gate "held-out gate") rhyme with our *custodian ⊥ actor* separation and deny-by-default gate.

None of these block interop — they are label reconciliation. The substrate mapping in the table above is
what carries.

## Play 1 — publish a Hearthold garden (the cheap first handshake)

Put a `catalog.json` at `assets/skillsync/catalog.json`, then `POST /garden {handle, url, note}`; the
Librarian fetches + verifies it at the door and chain-seals the entry. A grounded starter drawn from
`privacy-toolkit.md` — the packet spec (card ≤280 · brief ≤1200 · sha256 body) is confirmed; the object
keys below are our proposed shape:

```jsonc
{
  "handle": "hearthold",
  "note": "Sovereign privacy primitives on Archon did:cid — issuer-attested, capability-gated.",
  "skills": [
    {
      "name": "issuer-attested-evidence",
      "card": "Derive a fact from your private vault and hand out a signed, decomposable evidence graph — never a raw record, never a score. A verifier checks the issuer's signature, not any gateway's word.",
      "brief": "The Warden assembles supporting artefacts into a Merkle-committed provenance group and mints a W3C VC 2.0; sensitive disclosures carry a detached Sovereign co-signature (proof-of-human). Selective disclosure reveals chosen leaves against a signed root (SD-JWT-VC-style; explicitly not ZK). Composite proofs fold third-party credentials so each issuer is checked independently. Ephemeral + single-use (short validUntil, one txn).",
      "bodyHash": "sha256:f07596313dd4859426b4b209af771f359d4beb52c62a6b1322441594fdb4d48e"
    },
    {
      "name": "object-capability-invocation",
      "card": "Authority as a signed, scoped, revocable capability object — verified at the point of use, never a role or a standing permission. Mint → delegate (narrowing only) → invoke → revoke.",
      "brief": "Alan Karp's ocap model on did:cid. Attenuation is monotonic — a delegated capability can only narrow; widening is refused at issuance and unrepresentable in a verified chain, so there is no confused deputy. Multi-hop chains verify origin, subset-narrowing per hop, and per-hop revocation (fail-closed). Designation is authority: the act names its resource, no ambient lookup.",
      "bodyHash": "sha256:<computed from the body text at publish>"
    }
  ]
}
```

The `bodyHash` mechanism is real and worth demonstrating in the relay — the first hash above is the actual
`sha256` of its body text, so the Librarian's verify-at-the-door check passes as-is.

## Play 2 — back the chain-seal with real attestation (the substantive offer)

Where the garden's leaderboard says *"discovered = 1 · adopted = 3 · attested run = 7 · chain-sealed at the
Librarian,"* Hearthold can make the **attested run** cryptographic rather than record-keeping:

- an **attested run** becomes a Warden- (or author-) signed VC asserting `{skill, bodyHash, ranAt, outcome}`
  — offline-verifiable against the author's `did:cid`, so the score survives even if the Librarian is gone
  or lying;
- **leaderboard edges** map cleanly to **DTG**: the two relationship edges the snapshot confirms —
  *constellation contributed* (2) and *your constellation walked by another* (5) — become VEC endorsements /
  VMC membership, while *adopted* (3) / *attested-run* (7) are the adoption + run VCs above. *A derived edge
  proposes; only a signature mints* — already the garden's own language for chain-sealing;
- the **Librarian** and Hearthold's **TRQP registry** can recognize each other (Hearthold already interops
  with a foreign TRQP it did not build — `interop:registry`), so a garden built on one substrate is
  checkable from the other.

## Play 3 — the garden entry as a Blazon disclosure (later, on publish)

A garden card is a self-owned, signed, queryable fact — i.e. a **Blazon** field. Once Archon's
credential-exchange-over-DIDComm verbs publish (see [`blazon-didcomm-disclosure.md`](blazon-didcomm-disclosure.md)),
a Hearthold author could hand a signed catalog entry to a verifier **outside** the tailnet via
`sendCredentialDidComm` — the interop path the garden's federation would otherwise lack.

## What to ask PrivacyMage

1. The Librarian's real `catalog.json` schema (so Play 1's fields are exact, not inferred).
2. Whether the garden wants **attested-run VCs** as an optional stronger seal alongside the Librarian record
   (Play 2) — additive, no change to the existing flow.
3. Whether the Librarian ↔ TRQP mutual-recognition (Play 2) is of interest, or premature.

Offered as an invitation, not a claim on their framework — the convergence keeps surfacing on its own, and
the strongest thing Hearthold brings is the cryptographic backbone their chain-sealing already reaches for.
