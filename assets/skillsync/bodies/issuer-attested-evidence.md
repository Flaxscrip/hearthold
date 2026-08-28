# Issuer-attested evidence

Derive a fact from a private data history and hand out a **signed, decomposable evidence graph** — never a
raw record, never an opaque score. Trust rests on the **issuer's signature**, verified against their
`did:cid`, not on any gateway's or custodian's word.

## When to use

- A verifier needs to check a fact (age, membership, a threshold, an attested run outcome) without seeing
  the data behind it.
- You want a claim that survives offline: checkable by anyone who can resolve the issuer, with no
  dependence on the service that emitted it.

## How it works (Hearthold / Archon `did:cid`)

1. **Gate.** Every disclosure crosses a deny-by-default release decision (`decideRelease`): sensitivity ×
   authorization tier × disclosure mode. Sensitive facts force a step-up — a Sovereign co-signature
   carrying a proof-of-human assertion.
2. **Mint.** The custodian (Warden) assembles the supporting artefacts into a **Merkle-committed provenance
   group** and mints a W3C VC 2.0 whose `credentialSubject.evidence` carries the provenance as content
   hashes.
3. **Disclose.** Selective disclosure reveals chosen leaves against a signed root (SD-JWT-VC-style;
   explicitly **not** ZK). Composite proofs fold in third-party credentials, each issuer checked
   independently.
4. **Bound.** Ephemeral (`validUntil`) and single-use (one `txn`, burn-on-reuse).

## Invariants

- Issuer-attested, never the custodian's word.
- No reputation score is ever emitted — only a verifiable, decomposable graph.
- On-device derivation; content never leaves the machine to be classified.

Reference: `docs/evidence-graph.md`, `core/evidence.ts`, `core/prove.ts`, `core/security.ts`.
