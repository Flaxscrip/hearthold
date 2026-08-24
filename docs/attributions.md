# Attributions & prior art

Hearthold is a reference implementation built on **open standards and small primitives, not a framework.**
Where we adopt or adapt an external design, we credit it here *and* in the file header of the code that
implements it. This ledger grows as we build.

## Conceptual foundation — the Privacy Is Value Model

Hearthold began as a single brief: **"implement the Privacy Is Value Model (PVM) on Archon."** The PVM
(Mitchell / agentprivacy, <https://agentprivacy.ai/model>) is the conceptual spine, not a parallel we
noticed after the fact — the architecture is a deliberate instantiation of its terms.

| PVM concept | Author / body | How Hearthold instantiates it | Where |
|---|---|---|---|
| **The 7th Capital** — a person's behavioural data history as measurable capital, privacy as *value* rather than a policy promise | **Mitchell / agentprivacy** | The Warden custodies the full history on-device; disclosure emits verifiable evidence, never the data — value is realized without spending the capital. | `packages/warden`; `docs/evidence-graph.md` |
| **Dual-agent custody separation** — separate the custodian of data from the agent that acts in the world | agentprivacy | Warden (custodian/enforcer) vs Emissary (world-facing companion under a scoped, revocable delegation); neither alone reconstructs the whole. | `packages/warden`, `packages/emissary`; `CLAUDE.md` |
| **Multiplicatively-gated value** `V(π,t)` — any protective term at zero collapses the whole | agentprivacy | Deny-by-default release ladder: every disclosure crosses `decideRelease()`; a failed gate (revocation, expiry, missing consent) fails the whole disclosure closed, it doesn't degrade it. | `packages/core/src/security.ts`; `invocation-monitor.ts` |
| **Three sovereignty axes** — Φ_agent, Φ_data, Φ_inference | agentprivacy | Φ_agent = each agent its own `did:cid`; Φ_data = on-device custody; Φ_inference = local classification, only derived facts leave. | `packages/core/src/identity.ts`; on-device classifier; `docs/security-model.md` |

**Honest divergence (recorded, not glossed):** the PVM contemplates zero-knowledge proofs for reconstruction
resistance; Hearthold ships **salted-Merkle selective disclosure** (`evidence.ts`) instead — verifiable and
decomposable, but not ZK. The substrate is **Archon `did:cid`**, not the Zcash/Nillion stack the model
references. These are implementation choices on the same value model, and are called out so the alignment
reads as instantiation, not aspiration.

## Capability & invocation layer

Design: `docs/invocation.md`. The shipped single-hop mechanism is `packages/core/src/capability.ts` +
`capability-vc.ts` + `invocation-monitor.ts` (a Sovereign-issued scope VC verified with `verifyProof`).
`packages/core/src/attenuation.ts` + `capability-chain.ts` (multi-hop chain attenuation) are **now on the
enforcement path too** (Phase 5B, 2026-08-10): `resolveChainInvocation` verifies a disclosed attenuation chain
with per-hop revocation and single-hop parity, proven by `e2e-multihop-confused-deputy`. See
`docs/multihop-delegation.md` for the parity map; the daemon-facing verb + watch dashboard are the remaining
additive wiring.

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
- Mitchell / agentprivacy, *"Privacy Is Value Model"* (PVM): <https://agentprivacy.ai/model>
- A. H. Karp, message to W3C public-credentials (Sep 2022):
  <https://lists.w3.org/Archives/Public/public-credentials/2022Sep/0056.html>
- ZCAP-LD, W3C-CCG: <https://w3c-ccg.github.io/zcap-spec/>
- A. Birgisson, J. G. Politz, Ú. Erlingsson, A. Taly, M. Vrable, M. Lentczner, *"Macaroons: Cookies with
  Contextual Caveats for Decentralized Authorization in the Cloud,"* NDSS 2014:
  <https://research.google/pubs/pub41892/>
- HDP agentic-delegation draft: <https://datatracker.ietf.org/doc/draft-helixar-hdp-agentic-delegation/>
