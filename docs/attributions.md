# Attributions & prior art

Hearthold is a reference implementation built on **open standards and small primitives, not a framework.**
Where we adopt or adapt an external design, we credit it here *and* in the file header of the code that
implements it. This ledger grows as we build.

## Capability & invocation layer

Design: `docs/invocation.md`. Implementation begins in `packages/core/src/capability.ts` (composing
`packages/core/src/attenuation.ts`).

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
  pointers, signed subset assertions). The capability layer composes it.
- **W3C Bitstring Status List** — `packages/core/src/status-list.ts` (revocation, fail-closed).
- **Archon `did:cid`** (`@didcid/*`) — identity, DIDComm v2 **authcrypt** sender-authentication, Verifiable
  Credentials, groups, and temporal-proof resolution. See `~/archon`.

## Full citations
- A. H. Karp, message to W3C public-credentials (Sep 2022):
  <https://lists.w3.org/Archives/Public/public-credentials/2022Sep/0056.html>
- ZCAP-LD, W3C-CCG: <https://w3c-ccg.github.io/zcap-spec/>
- A. Birgisson, J. G. Politz, Ú. Erlingsson, A. Taly, M. Vrable, M. Lentczner, *"Macaroons: Cookies with
  Contextual Caveats for Decentralized Authorization in the Cloud,"* NDSS 2014:
  <https://research.google/pubs/pub41892/>
- HDP agentic-delegation draft: <https://datatracker.ietf.org/doc/draft-helixar-hdp-agentic-delegation/>
