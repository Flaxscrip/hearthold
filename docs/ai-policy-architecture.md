# Hearthold — A Data Security Architecture for Policy-Constrained AI Agents

**Audience:** DIF Trusted AI Agents WG and anyone exploring the problem space of Tom Jones's *"AI Constrained by Policy"* (Rule of Law for agents).
**Status:** Running code, live deployment. Knowledge Portal: https://kb.archon.social/ · Source: https://github.com/Flaxscrip/hearthold
**Companion diagram:** `hearthold-data-security-architecture.html` (same folder)

---

## 1. The claim, in one paragraph

Tom's paper argues that prompt-embedded instructions cannot govern AI agents, and proposes a dual-mode model: **nondeterministic prompt handling, deterministic policy enforcement** — a policy engine distinct from the AI, holding user-authored, machine-readable policy that no service provider can manipulate. **Hearthold is a running implementation of that shape.** Its rule: *probabilistic components propose; deterministic components dispose.* Every LLM in the system (a local classifier, a local RAG answerer, agent-authored scripts) sits in a propose-only lane; every action that touches data or crosses a trust boundary passes a deterministic policy engine (the Warden) enforcing the human principal's signed policy (Rulesets), with the human's device (the Signet) as the root of authority.

## 2. Tom's formal sketch, instantiated

Tom: `O = δ_D(δ_N(p), π)` — nondeterministic interpretation `δ_N`, deterministic policy filter `δ_D`, user policy `π`.

Hearthold's bindings:

| Symbol | Hearthold implementation |
|---|---|
| `δ_N` (nondeterministic interpreter) | Local Ollama models: sensitivity classifier, RAG recall over the vault, script drafting. All local to the user's hardware; all output labeled `machine-derived`; none can act. |
| `π` (user policy) | **Ruleset chains** — versioned, append-only policy documents, one per governed actor, **signed by the human principal** (detached secp256k1 via their own wallet). An unsigned or broken-chain policy is refused. |
| `δ_D` (deterministic filter) | The **Warden**: `decideRelease(sensitivity × authorization-tier × disclosure-mode)` plus per-actor Ruleset checks (`kinds / verbs / ceiling / assurance`) applied **at egress** — pure functions, no model in the loop. |
| `O` (guaranteed-safe output) | A derived, scoped, expiring, audience-bound verifiable credential — never a raw data dump, never a score. |

## 3. Point-by-point against the paper

**"A policy engine distinct from the AI."** The Warden is deterministic code enforcing signed policy; the models it hosts cannot modify it. Hardened further: policy changes themselves require the principal's signature at their own device (proof-of-human gated), and readers **pin the governor's key** — a compromised, root-level Warden that self-signs a policy downgrade is *rejected by verification and fails closed*. Proven live in e2e (`e2e:ruleset-governance`). Rule of Law includes the case where the enforcer goes rogue.

**"A personal agent that MUST NOT be manipulated by providers"** (Tom's natural-language→policy reduction). Hearthold's consent surfaces are structurally provider-proof: when any agent (including a third-party AI requesting data) triggers a disclosure decision, **the description shown to the human is authored by the Warden, never by the requesting agent**. The requester's words are input evidence, not the consent screen. In an agentic world this closes the manipulation channel that requester-authored consent artifacts open.

**"The user is in control... the AI can request additional permissions"** (bidirectional, query-callback). Implemented as the step-up ladder: an agent hitting its ceiling doesn't fail silently — the Warden relays a purpose-bearing approval request to the principal's Signet (challenge-bound, single-use transaction id); the human approves with a fresh proof-of-human or declines (`GovernanceDeclined` — the action simply never happens).

**"Audit trail may record the transaction but not uncommitted user private data."** Exactly Hearthold's evidence discipline: what's recorded and disclosed are **hash commitments** (salted Merkle roots over supporting records), transaction ids, and signed approval statements — never payloads. The live Knowledge Portal states the operational corollary: *your query is not logged.*

**Jailbreaks: containment, not prevention.** Tom is right that probabilistic guardrails fail probabilistically. Hearthold's answer is architectural: **the LLM is never the security boundary.** A fully jailbroken classifier can at worst *misclassify* — and its failure mode is pinned safe: anything unclassified or uncertain defaults to SEALED (most-restricted), requiring the strongest human authorization to ever disclose. A fully jailbroken agent script can at worst *propose*; its egress is checked against its own Ruleset by the Warden at the boundary. Prompt injection can corrupt an interpretation; it cannot widen an authorization.

**Retrieval control for RAG.** Recall runs entirely on the principal's hardware; the vector index holds embeddings + metadata only (no plaintext); retrieval is scoped by a sensitivity ceiling (e.g., casual queries never touch SEALED material); shared-KB queries are end-to-end signed by the requester over a server nonce, so the relaying agent cannot forge identity — and membership is checked against a trust registry before the KB answers.

**Per-relationship policy** (Tom §2: each user-created relationship can carry independent policy). One Ruleset chain per governed actor, plus **pairwise DIDs per relationship** (per ToIP DTG v0.3's R-DID requirement): each counterparty sees its own identifier and operates under its own policy chain; nothing correlates across relationships unless the principal deliberately chooses it. This is now running code: the Warden **refuses** to bind an external grant or a DTG relationship edge to a non-pairwise subject unless a Sovereign-signed Ruleset exception explicitly names that counterparty — the deliberate choice is made signed, versioned, and auditable, not a checkbox (`e2e:pairwise-grant`, on the `feat/a2a-cgpr` branch).

**The taxonomy's missing "responsible party"** (Dmitri Zagidulin's observation: data models carry model + agent, not who is legally accountable). In Hearthold every actor is a DID and every authority is a **credential chain that terminates at the principal**: agent → scoped delegation credential (issuer: the Warden) → Warden policy (signed by the principal) → the principal's DID. Accountability isn't a metadata field; it's the signature chain itself, offline-verifiable by anyone.

**"Context built in the user agent is a HUGE PRIVACY VULNERABILITY."** This is the deepest agreement. Hearthold's premise is that the context problem is a *custody* problem: personal context (location history, documents, preferences, credentials — the "7th Capital") lives in the principal's own sealed vault on their own hardware, **not** in any platform agent's context window. When an AI legitimately needs context ("dietary preferences, for meal planning, 72 hours"), it receives a **derived, purpose-bound, expiring, single-use credential** answering exactly that question — issued to a pairwise identifier, consented at the principal's device, verifiable offline. The standing context blob never exists outside the home.

## 4. Tom's grant vocabulary → Hearthold's shapes

Tom's Cedar sketch: `Grant { action, scope, condition, delegatedBy, validFrom, validUntil, override }`. Hearthold's running equivalents:

| Tom's field | Hearthold |
|---|---|
| `action` / `scope` | `capabilities: { kinds, verbs }` in the Ruleset; kind-scoped delegation credentials for agents |
| `condition` (consent, timeBound, auditable) | authorization ladder (STANDING → CHALLENGE → HUMAN → MULTIFACTOR) + `capabilities.assurance` (e.g. `{ write: 'factor2' }`) |
| `delegatedBy` | credential issuer + the Sovereign's signature on the governing Ruleset |
| `validFrom/validUntil` | same fields, W3C VC 2.0 |
| `override` | there is deliberately **no emergency override of the human**; the nearest concept is a Ruleset supersession — which itself requires the principal's fresh signature |
| `consent:check` | the Signet approval flow (proof-of-human assertion embedded in the disclosure) |
| `log:decisions` | signed approval statements + hash-committed evidence groups (transaction, not payload) |
| `delegate:agent` | delegation credentials; transitive delegation absent by default (Tom's SPKI "do-not-delegate bit" is the default state, relaxed only by explicit policy) |
| `cite:sources` | machine-derived answers carry citations (record id, kind, timestamp, relevance) as a matter of format |

A Cedar/OPA engine could sit beside this happily — Rulesets are deliberately simple structured documents, and the WG's policy-language work could *compile to* Ruleset capabilities. We'd welcome that conversation; what Hearthold contributes is the part policy languages don't cover: **who signs the policy, where it's enforced, and what leaves when it permits.**

## 5. What Hearthold does not claim

- Rulesets are structural JSON with deterministic evaluation — not a full policy language (no deontic logic, no Cedar-style analyzability yet). See §4's compile-to path.
- Selective disclosure is salted-Merkle + elision, not ZK; predicate-proof modes are a defined seam, not shipped.
- The reference deployment is a single home-server trust domain; multi-Warden and heavy-concurrency deployments are future work.
- The proof-of-human ladder currently runs at assurance level 1 (PIN gate); biometric/liveness rungs are designed, not shipped.

## 6. One worked scenario (Tom's A-agent world, end to end)

A hotel's AI needs a guest's dietary preferences (the consumer↔broker↔subcontractor pattern from the DIF H&T thread). The request arrives as a subject-less, expiring, single-use ticket; the Warden authors the human-readable consent line: *"The hotel kitchen asks: dietary restrictions and cuisine preferences, for meal planning, valid 72 hours, single use."* The principal's watch taps approval (proof-of-human). The Warden mints a credential to a **fresh pairwise DID** — containing the derived claim only — and the hotel's AI verifies it offline. It expires in 72 hours, refuses reuse, and revokes with one message. The broker in the middle carried sealed envelopes and learned nothing. This flow now **runs end-to-end**: the subject-less A2A request over the gateway, the ticket validation, the Warden-authored consent, the mint to a fresh pairwise DID, and the offline challenge/response verification are e2e-tested (`e2e:cgpr-gateway`, `e2e:pairwise-grant`, on the `feat/a2a-cgpr` branch); the proof-of-human step-up is the existing Signet ladder (`e2e:prove`, `e2e:evidence-stepup`); the broker's B-side and the full conformance suite are specified in the public brief (`A2A-BRIEF.md`) and in progress.

## 7. Pointers

Live portal: https://kb.archon.social/ · Repo & e2e suites: `Flaxscrip/hearthold` (`e2e:ruleset-governance`, `e2e:cantrip-auth`, `e2e:prove`, `e2e:dtg-set`, …; and on the `feat/a2a-cgpr` branch: `e2e:pairwise-grant`, `e2e:cgpr-schemas`, `e2e:cgpr-gateway`) · Security model: `docs/security-model.md` · Trust graph & delegation: `docs/trust-graph-and-delegation.md` · Identity substrate: Archon `did:cid` · Alignment: W3C VC 2.0 · DIDComm v2 · ToIP TRQP v2.0 · ToIP DTG v0.3 · A2A gateway (happy-path shipped on `feat/a2a-cgpr`; conformance in progress).
