# Hearthold ↔ AgentPrivacy skill garden — integration proposal

*Draft material for GenitriX to relay to PrivacyMage/Mitchell. Grounds the "Skills of the AgentPrivacy
Universe" garden ([skills.agentprivacy.ai](https://skills.agentprivacy.ai/)) against Hearthold's shipped
identity + attestation layer. Nothing here is sent from Hearthold directly — it is a proposal for the
First Person's channel.*

> **Status:** proposal. Field names in the sample `catalog.json` are illustrative and must be reconciled
> with the Librarian's actual schema before publishing (the public page states only *card ≤280 · brief
> ≤1200 · sha256 body hash* — the rest is inferred). Companion: [`privacy-toolkit.md`](privacy-toolkit.md).

## The shape of the match

The skill garden and Hearthold are the same universe approached from two sides. The garden already reaches
for properties Hearthold ships as primitives:

| Garden concept | Hearthold primitive it maps to |
|---|---|
| **chain-sealed** entry / **attested run** | issuer-attested **VC** signed by a `did:cid` — a real signature, not the Librarian's word |
| `catalog.json` + **sha256 body hash** | content-addressing — the same "re-derive, never trust by name" as `did:cid` |
| **the Librarian** (fetch, verify ✓, standing tiers) | a **ToIP TRQP** trust registry (outward issuer-trust + inward standing) |
| **leaderboard** reputation edges (discovered/adopted/attested) | **DTG** trust-graph credentials (VRC/VMC/VIC/VEC) — edges minted by signatures |
| **Counsel** (attributed, weighed-not-obeyed) | Archon challenge/response attribution + the AgentGate consent model |
| **loadout decks** (briefs first, bodies on task-fire) | the Fold's census/sample + Hearthold recall's load-on-demand |

The one-line thesis to offer: **the garden's "chain-seal" is exactly what Hearthold's issuer-attested
signature layer provides cryptographically.** A garden entry that is "attested" by the Librarian's record
is trust-on-the-Librarian; the same entry carried as a Warden- or author-signed VC is trust-on-the-issuer,
verifiable offline by anyone, no Librarian required.

## Play 1 — publish a Hearthold garden (the cheap first handshake)

Put a `catalog.json` in the federated roster; the Librarian fetches + verifies it at the door. A grounded
starter, drawn from `privacy-toolkit.md` (illustrative structure — confirm fields against the Librarian):

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
- **leaderboard edges** ("your constellation walked by another") become **DTG** edges (VEC endorsements /
  VMC membership) — *a derived edge proposes; only a signature mints*, which is already the garden's own
  language for chain-sealing;
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
