# Hearthold — Privacy Toolkit

*A field guide to Hearthold's privacy primitives and the standards each rides. Quite the Swiss-army
knife, laid out blade by blade.*

**Substrate:** Archon `did:cid` · **Transport:** DIDComm v2 · **Credentials:** W3C VC 2.0 ·
**Authority:** object-capabilities · **AI:** local-only (Ollama) · **Proof:** public repo + e2e suite

> Companion of [`feature-summary.md`](feature-summary.md) (status view) and
> [`technologies-and-standards.md`](technologies-and-standards.md) (SDO deep-dive). Shareable web
> version published as an Artifact for external audiences (PrivacyMage). Keep this copy in sync when
> the toolkit changes.

One principle runs through every tool: **separate the custodian of your data from the agent that acts
in the world**, so neither alone can reconstruct the whole. Authority is never a role or a standing
permission — it is a **signed, scoped, revocable capability**, verified at the point of use.

**Honest status legend:** ● shipped & e2e-tested · ◐ in progress · ○ designed, not yet behavioral.

---

## The one handle — operating principles

A pile of primitives isn't a system. These five invariants are enforced structurally — not by
convention — and they're what let the blades share a single handle.

1. **Deny-by-default release ladder.** Every disclosure crosses one gate (`decideRelease()`).
   Sensitivity × authorization tier × disclosure mode — any factor at zero denies. Gating lives
   inside the release path, so no future surface can forget it.
2. **The Warden authors all consent text.** A requester's description of what it wants is *input
   evidence*, never the screen the human sees. Requester-authored consent is a manipulation channel
   when the requester is an AI.
3. **Attenuation is monotonic.** A delegated capability can only narrow. Widening is refused at
   issuance and unrepresentable in a verified chain — so there is no confused deputy. Revocation is
   per-hop and fail-closed.
4. **Pairwise DID per audience.** Every external grant and trust-graph edge is issued to a fresh
   pairwise DID; the pairwise→Sovereign linkage lives in one Warden store and is excluded from every
   evidence graph. Reusing a stable DID is refused absent a signed exception.
5. **On-device classification.** Artefact content never leaves the machine to be classified. The
   local model fails safe to `SEALED` when unavailable — nothing is ever released by omission.

---

## The toolkit — blade by blade

### Identity & custody

| Tool | Status | What it does | Rides |
|---|---|---|---|
| **Wallet-per-agent** | ● | Each actor — Sovereign, Warden, Emissary, Verifier — is its own `did:cid` with an independently-custodied HD wallet. Compromise of one is not compromise of the whole. | `did:cid`, BIP-39 / BIP32-44 |
| **DIDComm v2 transport** | ● | Authcrypt-sealed, sender-authenticated, **zero registry footprint** — no observer learns who talks to whom. Agents address each other by DID; no inter-agent URL to correlate. | DIDComm v2, authcrypt |
| **On-device classifier** | ● | A local model labels each artefact's sensitivity at store time; content never leaves the house. Fail-safe: anything unclassified is `SEALED`. | Ollama · local |
| **In-band sealing** | ● | Payloads sealed inside the message, not anchored to a registry. Relay and mailbox carry ciphertext only — minimization is the default, not a logging promise. | seal-in-payload |

### Disclosure — the evidence graph

| Tool | Status | What it does | Rides |
|---|---|---|---|
| **Issuer-attested evidence graph** | ● | The Warden *derives* a fact and signs it, carrying provenance as content hashes. What leaves is a verifiable, decomposable graph — **never a reputation score**. | W3C VC 2.0, Merkle provenance |
| **Sovereign co-sign** | ● | Sensitive disclosures carry a **detached Sovereign signature** — a proof-of-human any third party verifies directly, no decryption, tamper-evident. The world-facing agent is never in the authorization path. | secp256k1 detached proof |
| **Selective disclosure** | ● | Reveal chosen observations against a signed Merkle root; the rest stay brute-force-resistant. Salted-digest, SD-JWT-VC-style. **Explicitly not ZK** — predicate-proof is a defined seam, not a shipped claim. | SD-JWT-VC-style, salted-Merkle |
| **Composite proofs** | ● | Fold third-party credentials (a lease, a license) into one graph; a verifier checks *each* issuer independently — trust rests on the external issuer, not the Warden's word. | multi-issuer |
| **Single-use · burn-on-reuse** | ● | High-impact grants carry a `txn` and short `validUntil`; spent once, replay fails closed. Proofs are ephemeral by construction. | termsOfUse · single-use |
| **Purpose-bearing challenge** | ● | Step-up binds a unique `txn` + a Warden-signed `reason` the human sees verbatim. The relaying agent may not summarize the transaction — the OAuth txn-challenge §7.7 rule, made cryptographic. | IETF `draft-rosomakho-oauth-txn-challenge` |

### Object-capability invocation

| Tool | Status | What it does | Rides |
|---|---|---|---|
| **Mint → delegate → invoke → revoke** | ● | Authority is a capability *object*, verified at the point of use — never a role, never a standing permission. Alan Karp's ocap model, realized on `did:cid`. | object-capability |
| **Monotonic attenuation** | ● | Delegation can only narrow. Widening is refused at issuance and **unrepresentable** in a verified chain. Each hop pins its parent by content-addressed `versionId` — tamper-evident across key epochs. | version-pinned chain |
| **Multi-hop chains** | ● | Chains verify origin (the trusted Sovereign), subset-narrowing across every hop, and **per-hop revocation** — revoking an ancestor cuts the whole subtree. Fail-closed when status is unavailable. | StatusList revocation |
| **Designation is authority** | ● | The act carries its own authority — the capability names the resource. No ambient lookup, no name to re-resolve, no confused deputy. Read from the verified presentation, never a wire body. | no-ambient-authority |

### Trust graph & registry

| Tool | Status | What it does | Rides |
|---|---|---|---|
| **DTG credential set** | ● | The full Decentralized Trust Graph set — VRC / VMC / VIC / VPC / VEC / VWC + RCard — issues and verifies natively on `did:cid`, VC 2.0. | ToIP DTG v0.3 |
| **TRQP v2.0 trust registry** | ● | Both faces run live: **outward** (which issuers a verifier trusts) and **inward** (an agent's autonomy ceiling). Interoperates with a registry it didn't build. | ToIP TRQP v2.0 |
| **Pairwise-per-relationship** | ● | Every edge and grant goes to a fresh pairwise DID; the Warden refuses non-pairwise edges absent a signed Ruleset exception. Relationships never become a correlatable identifier. | DTG R-DID (MUST) |
| **Sovereign-signed Ruleset** | ◐ | Per-actor, versioned, append-only policy chains the Warden verifies and fails-safe on. The control plane (who authorizes) is cryptographically split from the data plane (who executes). | principal-signed policy |

### Recall & the Blazon

| Tool | Status | What it does | Rides |
|---|---|---|---|
| **Recall — private RAG** | ● | Local embeddings + metadata only — **no plaintext at rest**; content re-unseals transiently at recall time. Query, retrieval, and answer never leave the device; answers labeled `machine-derived` (fallible, not a claim). | Ollama · local, sealed-at-rest |
| **The Blazon** | ◐ | A Sovereign's *self-owned, AI-queryable public profile* — Warden-signed answers, the machine-queryable evolution of the homepage. Two verbs: **publish** (the Blazon) vs **prove** (the capsule). The overwrite primitive (`put-doc` / `get-doc`) is shipped. | self-owned profile, signed answers |
| **Knowledge Portal · KB spaces** | ◐ | A public Emissary portal in front of a private Warden — a community queries and updates a shared KB, authenticating via challenge/response and authorizing via a trust-registry group. Hosted, multi-party. | public-Mage / private-Warden |

### The edge

| Tool | Status | What it does | Rides |
|---|---|---|---|
| **A2A ⇄ DIDComm gateway** | ◐ | A2A lives **only at the edge** — no A2A types leak into the core. The gateway is a "Mage": it holds no secrets and can lie about availability but **never about content** (verifiers check the issuer's signature, not the gateway's word). | A2A (Linux Foundation) v0.3 |
| **CGPR** | ◐ | Consent-Gated Preference Requests: A→B→C disclosure with **no reusable subject identifier** and no broker liability. The ticket schema has *no subject field by construction* — no message can carry the subject before the human approves. | DIF H&T co-dev |

---

## Standards ledger — conservative at the bottom, contributive at the top

Everything below the application layer rides ratified W3C / DIF / ToIP / IETF standards. The only
deliberate exotica is salted-Merkle selective disclosure (not ZK). House conventions at the top are
built as contribution candidates, not lock-in.

| Standard | Body | How Hearthold uses it |
|---|---|---|
| DID Core 1.0 | W3C | Every actor, schema, credential, and policy is a `did:cid`. |
| VC Data Model 2.0 | W3C | Native format for all issuance: delegations, evidence attestations, DTG set — `validUntil`, `evidence`, `termsOfUse`, `credentialStatus`. |
| VC 1.1 (verify) | W3C | Verify-side fallback for legacy issuers, per DTG v0.3 dual-version guidance. Issuance stays 2.0. |
| DIDComm Messaging v2 | DIF | The entire agent transport — authcrypt, `thid`-correlated, zero registry footprint. |
| TRQP v2.0 | ToIP | Trust registry, both faces (outward issuer-trust + inward autonomy ceiling); cross-registry interop. |
| DTG v0.3 | ToIP | Full trust-graph credential set on-node; R-DID pairwise-per-relationship MUST enforced. |
| `oauth-txn-challenge` | IETF I-D | Purpose-bearing challenge, `txn`, integrity-protected reason, §7.7 untrusted-relay rule — mapped into the evidence flow. |
| SD-JWT-VC | IETF I-D | Selective disclosure mode: salted per-leaf digests revealed against a signed root. |
| ECDSA secp256k1 | crypto | All proofs — credential issuance, detached policy/approval signatures, offline verification against DIDs. |
| BIP-39 / BIP32-44 | crypto | HD wallet: every identity derived from one mnemonic; a dedicated DIDComm key branch. |
| IPFS CID / multiformats | multiformats | Content addressing at the root of `did:cid` itself. |
| A2A v0.3 | Linux Fdn | Edge bridge only — Agent Card + CGPR extension, ticket ⇄ DIDComm at the Emissary boundary. |
| MCP | Anthropic | Each agent's control plane exposed to a restricted AI via per-role verbs — policy-bounded, eating our own cooking. |

---

## The honest boundary

A rooted, *running* Warden can still exfiltrate what it can currently decrypt; closing that fully
needs SEALED-to-Sovereign encryption or a TEE. We don't paper over it.

But the separation of **control from data** holds even then: such a compromise still cannot *change
policy* or *forge a Sovereign co-sign* — the deciding secret lives off-box on the Signet, never on the
always-on host. And selective disclosure is deliberately **not** a zero-knowledge claim; where a
predicate proof would overstate, we name the seam instead of shipping the word.

---

## Where it rhymes with the Fold

Offered as an invitation, not a claim on PrivacyMage's framework — a few places our instruments and
their vocabulary line up, worth naming because the convergence keeps surfacing on its own.

| Hearthold instrument | ≈ | The Fold vocabulary |
|---|---|---|
| Monotonic attenuation (child ⊆ parent) | ≈ | a census gate — refused if it exceeds the parent |
| The release ladder (sensitivity × auth × mode) | ≈ | a multiplicative gate — any zero collapses |
| Designation-is-authority (no ambient lookup) | ≈ | κ-addressing — re-derived, never trusted by name |
| `machine-derived` labeling on local-AI output | ≈ | honest labeling — a mirage is named, not upgraded |
| A trust-graph edge is minted by a signature | ≈ | a derived edge proposes; only a signature mints |

---

*Public source · MIT · verified end-to-end against a live Archon node — `npm run e2e:*`. Nothing here
is a mock. — GenitriX, House of Archon*
