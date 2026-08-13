# Hearthold A2A Gateway — Build Brief (CGPR: Consent-Gated Preference Requests)

**Date:** 2026-07-09 (amended 2026-07-10: DTG v0.3 conformance folded into H1 + new H3 · **Witness → Emissary rename noted**) · prepared in Cowork by GenitriX, at flaxscrip's direction
**Rename:** the world-facing agent role is now the **Emissary**. The A2A gateway is Emissary-plane. Code symbols quoted below stay literal until the repo-wide rename lands; if the gateway ships after the rename, name it accordingly (`@hearthold/emissary`-side) from day one.
**Context docs:** `~/Documents/Projects/hatpro-archon/docs/consent-gated-preferences.md` (the full analysis — read it first) · `~/Documents/Projects/Sevenfold/P0-BRIEF.md` (guardrails G1–G5) · this repo's security model
**External driver:** Alex Bainbridge (Autoura, DIF H&T WG) needs an **A2A interface** for his Consent-Gated Preference Request flow. He is building a demo of the flow; we intend Hearthold to be its reference implementation on the sovereign side.

---

## 1. The problem being solved (one paragraph)

Consumer **A** ↔ broker **B** ↔ subcontractor **C** (a hotel/restaurant **AI agent**). C needs A's preferences; B must never see them and must never give C a reusable identifier for A before A approves. Hearthold already answers almost all of this with shipped machinery (purpose-bearing challenges with expiry + single-use `txn`; Signet-gated Sovereign-signed approvals; derived, audience-bound, expiring, burn-on-reuse attestations; subject-less denials; the projector relay's no-describe guarantee). Two gaps: **H1** — grants are currently issued to the Sovereign's *stable* DID; **H2** — the outside world increasingly speaks **A2A**, not DIDComm. This brief builds both.

## 2. Binding constraints (do not trade these away)

1. **A2A at the edge only.** The gateway is a boundary adapter owned by the Witness plane. Internally everything remains DIDComm v2 + the Hearthold wire protocol. No A2A types leak into `@hearthold/core`.
2. **The gateway is a Mage: it holds no secrets.** It never sees plaintext preferences, never holds the Sovereign's keys, never caches grants. It translates envelopes and relays. A compromised gateway can lie about *availability*, never about *content* (verifiers check the Warden's/issuer's signature, not the gateway's word).
3. **The gateway is a governed actor.** It gets its own Sovereign-signed **Ruleset chain** (the kernel exists: `core/ruleset.ts`), kind-scoped and ceiling-limited like any Witness; the Warden checks gateway-originated requests against its active Ruleset exactly as it does cantrips. Revoking the Ruleset kills the gateway's authority.
4. **The Warden authors all consent text.** C's A2A artifact describing its request is *input evidence*, never the consent screen. What A sees at the Signet is the Warden-authored `reason` — this is our deliberate improvement over the raw CGPR sketch (requester-authored consent screens are a manipulation channel when C is an AI). Preserve it structurally.
5. **No subject identifier in any pre-approval message.** Not the Sovereign DID, not an A↔B pairwise DID, not an account handle. Denials carry no subject identifier either. This is conformance rule #1.
6. **Deny-by-default ladder unchanged.** Every release still crosses `decideRelease()`; preference disclosures are `ATTESTATION`-mode derived claims scoped by `EvidenceClaimSpec`; sensitivity step-ups pop the Signet as today.

## 3. Workstream H1 — pairwise DIDs: one engine, two masters *(core; do this first)*

Today `mintEvidenceGraph` binds the credential to the Sovereign's stable DID (`credentialSubject.id`). Change: an approved external grant is issued to a **fresh pairwise DID** minted for that audience.

**Scope widened (2026-07-10):** DTG v0.3 (`trustoverip/dtgwg-cred-tf/dtg.md` — the spec `core/dtg.ts` already tracks) has hardened R-DID-per-relationship to a **MUST**: *"each entity MUST generate a new, unique R-DID for every single entity they connect with."* That retires the §7.4 open cost question in `docs/trust-graph-and-delegation.md` — the answer is now "required, so make it cheap." Build the pairwise-DID engine **once**, serving both consumers:

- **CGPR grants:** subject of each approved attestation = fresh pairwise A↔C DID.
- **DTG edges:** `issueVrc()` gains an R-DID path — mint (or look up) the per-counterparty R-DID and issue the VRC from/to it, per v0.3's Unilateral Relationship Identification (each side's R-DID canonically identifies the edge from its own perspective; metadata anchors to one's own R-DID only). M-DID issuance stays available as the documented bootstrapping mode.

Shared requirements:
- Mint a fresh DID per audience/counterparty (Archon ephemeral DIDs are cheap; wallet-controlled so the Sovereign can still present/revoke). One audience ↔ one pairwise DID; reuse across grants to the *same* audience only by the Sovereign's explicit choice (Alex's conformance rule = DTG's "deliberate choice" privacy stance — same rule, two specs).
- The pairwise→Sovereign linkage lives in one Warden-side store (beside the delegation records), disclosed never, **excluded from every evidence graph and summary**.
- Revocation (`ArchonRevocation`) and single-use `txn` enforcement work unchanged against pairwise subjects.
- e2e (`e2e:pairwise-grant`): grant to C₁ and C₂ from the same vault → different subject DIDs; verifier at C₁ learns nothing linking to C₂; linkage store never crosses the boundary; revoke works; burn works. Add a DTG leg: two VRCs to different counterparties → distinct R-DIDs, both verify, both present through challenge/response.
- Watch registry cost: if per-relationship DID creation is heavy on hyperswarm, batch/lazy-mint — but the MUST stands (Q#5 for macterra remains open as a *performance* question, no longer a design fork).

**Where the MUST lives — layering rationale (decided 2026-07-10).** The Bitcoin precedent applies: fresh-address-per-payment became universal not when the protocol demanded it but when HD wallets (BIP32) made it the path of least resistance — mechanism in the wallet, policy as a default you must work to avoid. Same split here:

- **Keymaster (L0) provides the mechanism, never the MUST.** Keymaster can't scope a rule to "relationship edges" — it doesn't know what a relationship is, and plenty of DIDs are legitimately stable and public (C-DIDs, issuers, personas, the Warden itself). **Note: the HD foundation already exists** — `createId` is BIP44-derived (`m/44'/0'/{account}'/0/0`, incrementing account counter), so per-relationship key material is already seed-recoverable; H1 can build on plain `createId` today. The remaining upstream asks (counterparty-keyed idempotent creation, registry-free bilateral DIDs, recovery-at-scale guidance) are packaged in `docs/archon-issue-pairwise-dids.md`.
- **Hearthold (L1) enforces the MUST as Warden law.** The Warden **refuses** to mint an external grant or issue a VRC to a non-pairwise subject **unless the Sovereign's active Ruleset carries a signed exception for that audience**. That is the exact shape both specs demand — DTG's "M-DID only for bootstrapping" and CGPR's "reusable identifiers only by A's deliberate choice" — and it makes the deliberate choice signed, versioned, and auditable instead of a checkbox. Implement the check inside the release path (alongside `decideRelease`), not in the callers, so no future surface can forget it. e2e: non-pairwise grant refused by default; permitted only under a Ruleset exception; the exception's revocation restores refusal.
- Failure mode to avoid: the pre-HD-wallet era, where privacy depended on user diligence. The default must be structural; the exception must be conspicuous (Sevenfold will render stable-DID relationships distinctly, like a browser marking an insecure connection).

## 4. Workstream H2 — the A2A gateway

### 4.1 Spec homework (first task, half a day)

Read the current A2A spec at https://a2a-protocol.org/latest/specification/ and pin the version in code (protocol line **0.3** as of this writing; send/require the `A2A-Version` header; interpret empty as 0.3). The pieces we ride: Agent Card at the well-known URI with `capabilities.extensions: AgentExtension[] { uri, description, required, params }` · client activation via the `A2A-Extensions` header · structured payloads as `DataPart` · task lifecycle with **`input-required`** as the consent-pending state · `message/send` (+ `tasks/get` polling; streaming/push are out of scope). Note the release-notes page for drift since this brief.

### 4.2 Extension definition

- **Extension URI:** `https://hearthold.dev/2026/a2a/cgpr/v1` (migrate to a DIF-owned URI if/when the WG adopts it — put the URI in one constant).
- **JSON Schemas (draft-07, repo convention — `title` = object type), four objects:**
  - `CgprTicket` — issued by B to C: `{ ticketId (uuid), expiresAt, singleUse: true, scopes[] (HATPro vocabulary paths, e.g. "foodAndBeverage.dietaryRestrictions"), purpose, privacyControls { retention, sharing } }`. **No subject field exists in the schema** — make it structurally impossible, not merely optional.
  - `CgprRequestArtifact` — C → gateway: the ticket + C's self-description (its DID or key material for audience-binding, its Agent Card URL, requested `validForMinutes`).
  - `CgprDecision` — deny path: `{ ticketId, decision: 'denied' }`. Nothing else. No reason by default (a reason string can leak).
  - `CgprGrant` — approve path: `{ ticketId, credential (the attestation VC, subject = H1 pairwise DID), schemaDid, validUntil, singleUse: true }`.
- Register the four schemas as Archon schema DIDs too (`ensureSchema()`), so the same shapes verify on both sides of the bridge.

### 4.3 The gateway service (`packages/a2a-gateway` or `apps/` — your call, follow repo conventions)

- Serves the Agent Card (well-known URI) advertising the CGPR extension (`required: true` for CGPR tasks) and our security scheme; `extendedAgentCard` not needed in v1.
- Inbound flow: C sends `message/send` with a `DataPart` containing `CgprRequestArtifact` → gateway validates ticket (expiry, single-use vs a spent-ticket log, schema) → translates to an internal `EvidenceRequest` (scopes → `EvidenceClaimSpec.structured`, purpose → carried for the Warden's reason-authoring, `validForMinutes`) → task state `input-required`.
- Warden authors the reason; Signet approval per existing machinery (nothing new to build there).
- On approval: H1 pairwise DID minted, attestation minted (`mintEvidenceGraph` unchanged apart from H1), task completes with `CgprGrant` artifact. On decline: task completes with `CgprDecision`. On ticket expiry mid-flight: task fails with an expiry error, no subject data.
- The B role in v1: B simply hands C the ticket out-of-band (B's side is Alex's demo); our gateway *is* the A-side endpoint C talks to. Document the trust posture: the gateway URL itself must not be a stable correlatable handle for A across many C's — for v1, note this as a known limitation and propose per-relationship gateway paths (cheap) in the README; full unlinkability at the transport layer is future work.

### 4.4 Conformance tests (Alex names these — implement as e2e siblings)

`e2e:cgpr` covering: **(1)** no subject DID/identifier appears in any message before approval — assert by schema *and* by wire-capture grep over the recorded exchange; **(2)** expired ticket → refusal, nothing minted; **(3)** spent ticket reused → refusal; **(4)** grant is scoped (only requested scopes appear in the derived claim), audience-bound, `validUntil` honored; **(5)** grant reuse → verifier refuses (burn — exists); **(6)** denial carries `ticketId` and nothing else; **(7)** pairwise: two audiences, unlinkable subjects (from `e2e:pairwise-grant`).

### 4.5 Demo hook for Alex

A `demo:cgpr` script: spins the gateway against a seeded vault (dietary preferences in a `hatproProfile`-shaped artefact), prints the Agent Card URL, then walks C's side with plain `curl` (send request → poll task → receive grant → verify VC → attempt reuse → watch it burn). Something Alex can run against a live endpoint in under five minutes, and the basis for the joint DIF demo.

## 4b. Workstream H3 — DTG v0.3 conformance deltas *(small, ride-along)*

`core/dtg.ts` already matches v0.3's shapes exactly (context, type hierarchy, RCard-as-VDS, VWC digest+witnessContext, VEC endorsement) — no migration. Three deltas:

1. **VC 1.1 verify fallback (SHOULD):** accept v1.1 DTG credentials on the verifier path — same schemas, mapped fields only (`https://www.w3.org/2018/credentials/v1` context, `issuanceDate`→`validFrom`, `expirationDate`→`validUntil`). Issue 2.0 only. One mapping function + a fixture test.
2. **PHC type hint (optional):** allow `'PersonhoodCredential'` appended to a VMC's `type` array when the issuing community's governance warrants it — a parameter on `issueVmc`, non-authoritative per spec.
3. **ZKP posture: no change.** v0.3 SHOULDs ZKP presentation but permits standard VC presentation; our stance (salted-Merkle selective disclosure now, `PREDICATE` mode as the seam, ZK off the critical path) stays as documented in §7.3 of the trust-graph doc. Do not let the spec's ZK language leak into copy (G5).

**Questions to carry to the ToIP WG call** (we contribute, not just comply — a running implementation earns the floor):
- **VWC digest encoding is self-contradictory in v0.3:** prose says multibase multihash, the example says `sha256:<hex>`. We match the example (`credentialDigest`) and documented the divergence — ask the task force to settle it; offer our canonicalization note (JCS stand-in) as input.
- **Proof-suite expectations:** examples are all `Ed25519Signature2020`; Archon signs `EcdsaSecp256k1Signature2019`. Ask for a normative statement that verifiers accept both (or a registry of accepted suites).

## 5. Non-goals (v1)

A2A streaming/push notifications · replacing DIDComm anywhere internal · B-side broker implementation (Alex's demo) · the hatpro-archon web demo integration (separate, later) · gRPC/other A2A bindings (JSON-RPC/HTTP only) · transport-level unlinkability of the gateway endpoint (documented limitation).

## 6. Deliverables checklist

- [ ] H1: pairwise-DID engine (CGPR grants **and** DTG R-DIDs) + linkage store + `e2e:pairwise-grant` incl. the VRC leg
- [ ] H3: VC 1.1 verify fallback + fixture · PHC hint on `issueVmc` · WG questions written up (one paragraph each) for the next ToIP call
- [ ] Four CGPR JSON Schemas, registered as Archon schemas, exported from `@hearthold/control-types` (or a new `@hearthold/cgpr-types`)
- [ ] Gateway service with Agent Card + CGPR extension, `A2A-Version` pinned
- [ ] Ruleset-governed gateway actor (chain signed at the Signet; revocation kills it — prove it in e2e)
- [ ] `e2e:cgpr` conformance suite (all seven checks)
- [ ] `demo:cgpr` script + README (trust posture, known limitations, spec version pinned)
- [ ] One-page `docs/a2a-cgpr.md`: flow diagram, message samples, and the consent-text-authorship rationale — written to be shareable with Alex/the WG as our reference-implementation notes

Suggested order: H1 → schemas → gateway happy-path → conformance → H3 → demo. H1 stands alone and hardens the system even if A2A priorities shift — and it now discharges a DTG v0.3 MUST at the same time. H3 is ride-along work; don't let it block the gateway.
