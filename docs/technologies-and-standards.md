# Hearthold — Technologies & Standards Report

**Date:** 2026-07-10 · **Audience:** DIF/ToIP working groups, integrators, reviewers
**Live:** https://kb.archon.social/ · **Source:** github.com/Flaxscrip/hearthold
**Companions:** `ai-policy-architecture.md` (AI-policy mapping) · `standards-alignment.md` (OAuth txn-challenge deep-dive) · `security-model.md`

The design posture in one line: **conservative at the bottom, contributive at the top.** Everything below the application layer rides ratified W3C/DIF/ToIP/IETF standards; the deliberate exotica is limited to salted-Merkle selective disclosure (explicitly *not* ZK); and the house conventions at the top are all built as candidates for contribution, not lock-in.

---

## 1. W3C — identity & credentials

| Standard | Status | Use in Hearthold |
|---|---|---|
| DID Core 1.0 | Ratified | Every actor, artefact schema, credential, and policy is a `did:cid`. One Sovereign, one Warden, many Emissaries — each with its own DID and wallet. |
| Verifiable Credentials Data Model 2.0 | Ratified | Native format for everything issued: delegations, evidence-graph attestations, Rulesets' subjects, DTG set. Uses `validFrom`/`validUntil`, `evidence`, `termsOfUse` (single-use), `credentialStatus` (revocation). |
| VC Data Model 1.1 | Ratified (legacy) | Verify-side fallback (property mapping only) for interop with legacy issuers, per DTG v0.3's dual-version guidance. Issuance stays 2.0. |
| VC JSON Schema (`credentialSchema`) | Ratified | Every credential binds to a registered schema DID. |

## 2. DIF — Decentralized Identity Foundation

| Technology | Status | Use in Hearthold |
|---|---|---|
| **DIDComm Messaging v2** | DIF spec | The entire agent transport: Emissary submissions, evidence requests, proof presentations, the Warden↔Signet governance channel. Authcrypt-sealed, `thid`-correlated, zero registry footprint — relationships are never published. |
| **DIF H&T — HATPro profile** | WG draft | Reference implementation on Archon: hatpro.archon.technology (traveler wallet / supplier console / trust-registry explorer). HATPro's profile schema doubles as the scope vocabulary for consent-gated preference requests. |
| **DIF Trusted AI Agents** | WG (active) | Hearthold presented as a running instance of deterministic-policy-over-probabilistic-agents — see `ai-policy-architecture.md` and the architecture diagram in this folder. |
| **Consent-Gated Preference Request (CGPR)** | Co-development | A→B→C preference disclosure without broker liability or reusable subject identifiers; being developed with DIF H&T colleagues as an A2A extension, Hearthold as sovereign-side reference implementation (`A2A-BRIEF.md`, `feat/a2a-cgpr`). |

## 3. ToIP — Trust over IP

| Technology | Status | Use in Hearthold |
|---|---|---|
| **TRQP v2.0** (Trust Registry Query Protocol) | Approved | Both faces run live: **outward** (which issuers are authorized) and **inward** (what each agent/actor may do — the autonomy-grading face). Interops with a foreign registry it didn't build (`interop:registry`). |
| **DTG v0.3** (Decentralized Trust Graph credentials) | Task-force draft | Full credential set issued & verified on-node: VRC, VMC, VIC, VPC, VEC, VWC + RCard (VDS). **R-DID pairwise-per-relationship MUST implemented**: the Warden refuses non-pairwise edges/grants absent a signed Ruleset exception. Two spec questions carried back to the task force (VWC digest encoding; proof-suite expectations). |
| Trust Spanning Protocol | Watching | Flagged as future interop in the HATPro notes. |

## 4. IETF & related formats

| Standard | Status | Use in Hearthold |
|---|---|---|
| `draft-rosomakho-oauth-txn-challenge` | I-D | The transaction-authorization pattern (purpose-bearing challenge, `txn`, integrity-protected `reason`, §7.7 untrusted-relay rule) mapped and adopted into the evidence flow — see `standards-alignment.md`. Hearthold's collapse of PR+AS into the local Warden is the privacy-preserving variant. |
| SD-JWT-VC (selective disclosure) | I-D | The SELECTIVE disclosure mode is explicitly SD-JWT-VC-style: salted per-leaf digests revealed against a signed Merkle root. |
| jCard (RFC 7095) | RFC | RCard payloads — human-readable contact/identity cards. |
| JSON Schema draft-07 | De facto | All credential and policy schemas; `title` = credential type convention. |
| ISO 8601 | Ratified | All timestamps (`observedAt` vs `storedAt` kept distinct — event time vs custody time). |

## 5. Cryptography & key management

| Technology | Use in Hearthold |
|---|---|
| ECDSA secp256k1 (`EcdsaSecp256k1Signature2019`) | All proofs: credential issuance, detached policy/approval signatures (`addProof`), offline verification against DIDs. |
| SHA-256 (FIPS 180-4) | Content-addressed artefact ids, Merkle leaves/roots, credential digests (canonical-JSON). |
| **Salted-Merkle selective disclosure + elision** | The disclosure engine: per-observation salted leaf digests under a signed root; reveal chosen leaves, brute-force-resistant for the rest. Deliberately **not ZK**; predicate-proof modes are a defined seam (`PREDICATE`), not a shipped claim. |
| BIP-39 / BIP32-BIP44 HD wallets | Keymaster derives every identity from one mnemonic (`m/44'/0'/{account}'/0/{index}`; dedicated DIDComm key branch). Foundation for pairwise-DID-at-scale (see `archon-issue-pairwise-dids.md`). |
| IPFS CID / multiformats | Content addressing at the root of `did:cid` itself. |

## 6. AI & agent stack

| Technology | Use in Hearthold |
|---|---|
| **Ollama (local models)** | Sensitivity classifier (fail-safe: unclassified = SEALED), embeddings + RAG recall over the sealed vault, agent-script drafting. **All local to the Sovereign's hardware; all output labeled `machine-derived`; all propose-only.** No cloud model ever sees artefact content. |
| **A2A protocol (Linux Foundation), v0.3 line** | Boundary bridge in progress: Agent Card with the CGPR extension, ticket ↔ DIDComm translation at the Emissary edge. Internal transport remains DIDComm v2. |
| **MCP (Model Context Protocol)** | Archon node tooling is exposed to AI development agents via an MCP server — the build itself is done with policy-bounded AI agents, eating the cooking. |
| Deterministic policy engine (Warden) | Not a "technology" so much as the point: `decideRelease()` + per-actor signed Ruleset checks at egress. No LLM is ever the security boundary. |

## 7. Substrate — Archon `did:cid`

| Component | Use |
|---|---|
| Keymaster (HD wallet) | Key custody, credential issue/accept/revoke, detached proofs, encrypted wallet backup/recovery as a DID. |
| Gatekeeper | DID resolution (:4224); Drawbridge public proxy (:4222) as `nodeUrl`. |
| Registries | hyperswarm (default), BTC mainnet/signet, ETH, SOL — DID anchoring options. |
| Groups / Vaults / Polls / Dmail | Authorization groups back TRQP registries; encrypted vaults hold app state; polls & dmail available to compositions. |

## 8. House conventions — standardization candidates

| Convention | Path to contribution |
|---|---|
| Hearthold wire protocol (v0.4) — submission / evidence / approval / KB messages | Reference patterns for ToIP/DIF agent-custody work |
| **Ruleset chains** — per-actor, versioned, append-only, principal-signed policy; governor pinning fails closed | The enforcement half that policy languages (Cedar/OPA/ODRL) don't cover; "compile Cedar to Ruleset capabilities" is an open invitation |
| CGPR ticket/grant/decision JSON Schemas | To the DIF H&T WG as an A2A extension (in progress) |
| Warden-authored consent text (never the requesting agent's words) | Proposed as spec text for consent-bearing agent protocols |
| DTG-on-Archon implementation notes | Feedback loop into the ToIP dtgwg-cred-tf task force |

---

## Reading the stack

Three properties fall out of these choices. **Verifiability without connectivity** — everything that crosses a boundary is a signed credential checkable offline against issuer DIDs; no phone-home, no oracle. **Accountability as cryptography** — every agent authority is a signature chain terminating at a human principal's key, answering the "who is the responsible party?" gap in current agent data models. **Privacy as custody, not policy promise** — personal context never leaves the principal's hardware as a standing blob; what leaves is derived, purpose-bound, expiring, and pairwise-addressed. The standards above are the load-bearing walls of those three properties.
