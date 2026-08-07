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

## The keymaster contract (load-bearing assumptions)

Moving the capability anchor to Archon's credential-request ceremony relocated trust into
`@didcid/keymaster` rather than eliminating it. The invocation monitor performs **no cryptographic
verification of its own** — it trusts `verifyResponse` to have done it. These properties of the dependency
are therefore load-bearing; we state them as the contract Hearthold relies on. `did:cid` is content-addressed
and the ceremony is standard VC challenge/response, so we have reasonable confidence in each, but they are the
dependency's guarantees, not ours.

| | Assumption | What defends us in-tree if it were false |
|---|---|---|
| **A1** | `createResponse` encrypts the response to the challenge's controller; `verifyResponse` requires decrypting as that controller. | The **Warden-minted challenge** gate (`ChallengeStore`, `invocation-monitor.ts`): a presentation must answer a challenge *we* minted, so a holder self-minting its own challenge (any schema/issuer) is refused even if A1 didn't already make it undecryptable. `e2e-invocation-challenge` asserts both. |
| **A2** | Each VP's issuer signature is verified and a failing VP is omitted from `vps[]`. | Not independently re-verified in-tree — this one we *rely on*. `e2e-invocation-confused-deputy` (self-issued scope) exercises it end-to-end through the real ceremony. |
| **A3** | `responder` derives from the response DID's create-op signature, not a body field. | The **subject binding** (`resolveInvocation`: `subject === responder`) plus the **authcrypt `fromDid === holder`** check mean a bypass would need to defeat two independent bindings, not one attacker-chosen string. `e2e-invocation-confused-deputy` A3/A4 cover replay and copied-VC. |
| **A4** | `match`/`fulfilled`/`requested` are recomputed against the resolved challenge, not echoed from the response body. | Partially — the Warden-minted-challenge gate means an echoed `match` on a challenge we never minted is still refused. |
| **A5** | Revoked/expired VCs are rejected by `verifyResponse`. | We do **not** rely on this: the monitor checks `caveats.expires` and the `credentialStatus` pointer itself (`status-list.ts`, fail-closed), independent of the verifier. |
| **A6** | `metadata.authenticated` marks a genuinely sender-authenticated (authcrypt) envelope. | The transport infers authentication from `metadata.sender` presence (`transport.ts`); `metadata.authenticated` is not yet read. Tightening this to require the explicit flag is tracked hardening. |

Two smaller anchor notes: `expectedRootIssuer` unset no longer yields a `trustedIssuers: ['']` that matches an
empty issuer — `resolveInvocation` denies when it is empty. And `opts.schema` is enforced by the challenge the
Warden mints (A1), not only as a trust-registry `resource`.

## Full citations
- A. H. Karp, message to W3C public-credentials (Sep 2022):
  <https://lists.w3.org/Archives/Public/public-credentials/2022Sep/0056.html>
- ZCAP-LD, W3C-CCG: <https://w3c-ccg.github.io/zcap-spec/>
- A. Birgisson, J. G. Politz, Ú. Erlingsson, A. Taly, M. Vrable, M. Lentczner, *"Macaroons: Cookies with
  Contextual Caveats for Decentralized Authorization in the Cloud,"* NDSS 2014:
  <https://research.google/pubs/pub41892/>
- HDP agentic-delegation draft: <https://datatracker.ietf.org/doc/draft-helixar-hdp-agentic-delegation/>
