# Attributions & prior art

Hearthold is a reference implementation built on **open standards and small primitives, not a framework.**
Where we adopt or adapt an external design, we credit it here *and* in the file header of the code that
implements it. This ledger grows as we build.

## Capability & invocation layer

Design: `docs/invocation.md`. The shipped mechanism is `packages/core/src/capability.ts` +
`capability-vc.ts` + `invocation-monitor.ts` (a Sovereign-issued scope VC verified with `verifyProof`).
`packages/core/src/attenuation.ts` (multi-hop chain attenuation) is **retained but not on the shipped path** —
Phase 4, see `docs/invocation.md` §5.3.

| Design | Author(s) / body | What we use | Where in our code |
|---|---|---|---|
| Object-capability model; **"designation ≡ authority"**; the confused-deputy analysis; the required `authorization` vs `credential` type | **Alan H. Karp** (HP Labs; W3C public-credentials list) | The core principle that a capability fuses designation + authority (so a confused deputy cannot arise); his concrete recommendation that an authorization carry a required type distinct from a credential → `AUTHORIZATION_TYPE` / `HearthholdAuthorization`. | `capability.ts`; `docs/invocation.md` §2, §5 |
| **ZCAP-LD** — Authorization Capabilities for Linked Data | **W3C-CCG** | The capability data model (root vs delegated), monotonic attenuation (action/target/expiry narrowing), and the `capabilityDelegation` vs `capabilityInvocation` proof-purpose distinction. | `capability.ts` (`capabilityNarrows`, `targetWithin`); `docs/invocation.md` §5 |
| **Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the Cloud** (NDSS 2014) | **A. Birgisson, J. G. Politz, Ú. Erlingsson, A. Taly, M. Vrable, M. Lentczner** (Google) | Third-party caveats & discharge — consent modeled as a caveat discharged by a *designated* party, bound to the specific request (the `txn` binding) so it cannot be replayed. | `capability.ts` (`ThirdPartyCaveat`, `Discharge`); `docs/invocation.md` §5.3 |

### Contrast (not adopted — cited for positioning)
- **HDP — agentic delegation** (`draft-helixar-hdp-agentic-delegation`, IETF). Delegation-provenance only —
  by its own text *"an evidence trail, not a capability boundary,"* deferring runtime enforcement to the
  application layer. Hearthold *is* that enforcement layer. Cited in `docs/invocation.md` §2.

## Foundations already in the tree
- **Verifier-enforced attenuation over Archon `did:cid` Asset DIDs** — Hearthold's own
  `packages/core/src/attenuation.ts` (AuthoritySet ⊆ parent, salted commitments, version-pinned parent
  pointers, signed subset assertions). Exercised by `e2e-capability-chain`; **reserved for Phase-4 multi-hop
  delegation** and not called by the shipped single-hop invocation path.
- **W3C Bitstring Status List** — `packages/core/src/status-list.ts` (revocation, fail-closed).
- **Archon `did:cid`** (`@didcid/*`) — identity, DIDComm v2 **authcrypt** sender-authentication, Verifiable
  Credentials, groups, and temporal-proof resolution. See `~/archon`.

## Archon primitives we build on (and don't reimplement)

The invocation layer is authorization *policy* on top of Archon's credential-request ceremony — the same way
the rest of Hearthold builds on Vaults, DMail, backups, and asset registration without reimplementing them.
`keymaster.verifyResponse` verifies the presented credentials' signatures and their challenge-satisfaction
using the same `did:cid` resolution + signature layer we trust throughout; the monitor consumes its verified
outputs (the disclosed scope, the proven `responder`) rather than re-checking Keymaster's cryptography. That
delegation is deliberate and consistent — content-addressed identifiers and signed operations are exactly what
Archon exists to get right once, for every consumer.

What the invocation layer *adds* on top is the authorization it owns — none of it a re-verification of Keymaster:

- **The verifier mints the challenge.** The Warden issues the credential-request challenge (`ChallengeStore`),
  fresh and single-use, so a presentation is bound to this verifier and this occasion — standard object-capability
  audience binding, the reference monitor's job, not the credential layer's.
- **The caller is bound to the credential subject.** `resolveInvocation` requires `subject === responder` and the
  authcrypt sender `== holder`, so authority is control of the granted DID, not possession of a VC.
- **Revocation and freshness are checked against our own state.** `caveats.expires` and the `credentialStatus`
  pointer resolve against Hearthold's status list at invocation time — current revocation state is authorization
  policy the credential layer doesn't own.
- **Transport identity uses `metadata.authenticated`.** The Warden trusts the DIDComm sender only on an
  authcrypt-authenticated envelope (`transport.ts`) — reading Keymaster's own authentication flag, not inferring it.

## Full citations
- A. H. Karp, message to W3C public-credentials (Sep 2022):
  <https://lists.w3.org/Archives/Public/public-credentials/2022Sep/0056.html>
- ZCAP-LD, W3C-CCG: <https://w3c-ccg.github.io/zcap-spec/>
- A. Birgisson, J. G. Politz, Ú. Erlingsson, A. Taly, M. Vrable, M. Lentczner, *"Macaroons: Cookies with
  Contextual Caveats for Decentralized Authorization in the Cloud,"* NDSS 2014:
  <https://research.google/pubs/pub41892/>
- HDP agentic-delegation draft: <https://datatracker.ietf.org/doc/draft-helixar-hdp-agentic-delegation/>
