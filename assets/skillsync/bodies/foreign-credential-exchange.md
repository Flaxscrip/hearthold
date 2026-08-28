# Foreign credential exchange

Issue a verifiable credential to a subject **outside** your identity network and push the **signed
credential itself** to them over DIDComm — so a verifier who is not on your substrate can still check it by
resolving the **issuer's** DID and verifying the proof. No wallet, no shared registry, no import.

## When to use

- Hand a signed fact (a garden catalog entry, an attestation, a self-owned "Blazon" field) to a party
  outside the tailnet / outside Archon.
- Federate trust across substrates: the recipient trusts the issuer's signature, not the sender's word or
  any gateway's.

## How it works (Archon `did:cid` · issue-credential 3.0)

1. **Gate first.** The disclosure crosses the deny-by-default release ladder before anything is minted or
   sent.
2. **Mint for a foreign subject.** A non-`did:cid` subject makes the credential self-contained: it is
   encrypted-to-issuer and embeds its own asset id under the proof, so it carries everything a verifier
   needs.
3. **Push whole.** `sendCredentialDidComm` delivers the signed VC as an issue-credential/3.0 attachment. The
   recipient reads it directly and verifies the issuer via any Universal Resolver with the `did:cid` driver.

## Invariants

- Publish, not prove: this is a snapshot (short `validUntil` + revocable status), not an interactive proof
  ceremony.
- Trust is the issuer signature, resolved by the verifier — never the sender's assertion.
- Still gated: no surface emits a foreign credential without crossing the release decision.

Reference: `docs/blazon-didcomm-disclosure.md`, `core/credential-delivery.ts` (`discloseToForeignVerifier`).
