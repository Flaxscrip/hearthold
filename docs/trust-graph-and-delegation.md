# Trust Graph & Delegation — standards alignment (working solution)

Status: **design exploration**, developing toward a reference solution. Open questions for the Archon
maintainer (macterra) are collected in [§8](#8-questions-for-archon-macterra).

## 1. Why this note

We need a *structured* model for relationships and **delegation of authority** — who may act for
the Sovereign, and how far. An earlier sketch reached for the HATPro "VRC" (allow/deny/actions/limits/
`confirmAbove`). That was a convenient *vocabulary*, not a standard, and HATPro borrowed the term
**VRC** from upstream ToIP anyway. So the right move is to source the model from the upstream body:
the **Decentralized Trust Graph (DTG)** work at ToIP / the First Person Network, plus the adjacent
capability and approval standards. This note maps Hearthold onto those standards and records where
Archon would need to support them.

## 2. "Delegation" is three layers — keep them separate

The recurring trap is treating delegation as one thing. It is three, and the standards split cleanly:

| Layer | Question | Standards | Hearthold piece |
|---|---|---|---|
| **Relationship / graph** | who relates to whom; who vouches | **DTG credentials** (VRC/VMC/VWC/…), **TRQP** trust registry, did:cid relationship binding | the Sovereign↔Witness↔Warden↔third-party fabric |
| **Capability / token** | what a delegate may do, attenuably | **UCAN**, **ZCAP-LD**, **OAuth RAR** (RFC 9396), **GNAP** (RFC 9635), Biscuit | the standing envelope + `confirmAbove` |
| **Interactive approval** | how the human confirms above the line | **OIDC CIBA** (backchannel), GNAP interaction, **draft-rosomakho txn-challenge** (already aligned, R1–R5) | the **Signet** relay |

Hearthold already implements the *approval* layer (the Witness-as-projector relay to the Signet) and
tracks the txn-challenge draft (see [standards-alignment.md](standards-alignment.md)). This note adds
the **relationship** layer (DTG) and frames the **capability** layer as the open architectural call.

## 3. DTG credentials, in brief

DTG (First Person Network, ToIP) defines **six W3C VC types** + one Verifiable Data Structure, all
subtypes of an abstract `DTGCredential`, on **VC Data Model 2.0** (`validFrom`/`validUntil`) with v1.1
compatibility. Context: `https://firstperson.network/credentials/dtg/v1`.

| Type | Role | Issuer→Subject |
|---|---|---|
| **VRC** RelationshipCredential | a peer-to-peer relationship edge (verified by a bidirectional pair) | R-DID → R-DID |
| **VMC** MembershipCredential | membership of an entity in a community | C-DID → M-DID |
| **VIC** InvitationCredential | authorizes onboarding a new member | C-DID/M-DID → M-DID/C-DID |
| **VPC** PersonaCredential | links a public persona to a relationship | P-DID → counterparty |
| **VEC** EndorsementCredential | endorses skills/reputation (`endorsement` object) | endorser → endorsed |
| **VWC** WitnessCredential | **third-party attestation that an edge was established** | **W-DID** → observed party |
| RCard (VDS) | human-readable contact card (JCard / RFC 7095) | publisher → counterparty |

**DID taxonomy:** P-DID (persona/person), R-DID (relationship — *a unique DID per connection*),
M-DID (membership), C-DID (community), W-DID (witness). These are ordinary DIDs; their *role* is
assigned by the registry, not by a new DID method — so `did:cid` works as-is.

**The load-bearing principle — thin credential, fat registry.** DTG credentials are deliberately
minimal (often just `issuer` + `subject.id`). *Everything policy-bearing lives in the trust registry:*

> Trust Registries are the **authoritative source for roles** (initiator, trust anchor, member, IDVP…),
> map DIDs to roles and policies, determine acceptable issuers, and handle revocation. (dtg.md §9)

A **Personhood Credential (PHC)** is *not* a distinct schema — it is "simply a VMC issued by a VTC
whose governance enforces real personhood + one-membership-per-person." Personhood is a *registry/
governance* fact, not a credential field. Roles like "Raid-Lead" are likewise registry- or
endorsement-borne, not baked into the membership credential.

## 4. Hearthold ↔ DTG mapping

| Hearthold | DTG |
|---|---|
| **Sovereign** (First Person) | a person with a **P-DID**; personhood = a **PHC** (a governance-qualified VMC) |
| **Witness** (per device) | a **W-DID** that issues **VWCs**; "fair witness… may be an agent or bot authorized by the organization" |
| **Warden** (custodian) | holds the vault of received edges; could itself be a community agent |
| **Guild** | a community **C-DID** issuing **VMC** membership; the role ("Raid-Lead") is a **VEC** endorsement |
| our `issued` leaf | an inbound **VMC/VEC** accepted into the vault |
| our `witnessed` trust class | a **VWC** the Witness produced |
| our delegation VC (Warden→Witness) | a **VRC** edge, with the *authority* expressed in the registry (see §6) |
| our per-device Witness DIDs | DTG's **R-DID-per-relationship** privacy rule, applied to devices |
| our "no registry footprint" DIDComm | complements DTG's R-DID-per-connection unlinkability |

The mapping is close enough that Hearthold reads as an *implementation* of the DTG relationship layer
with a private vault (Warden), a local classifier, and an approval gate (Signet) added on top —
exactly the pieces DTG leaves to "the wallet."

## 5. The Witnessed-VRC flow *is* our Witness flow

`witnessed_vrc_flow.md` describes a "fair witness" (human *or bot*) that observes a relationship
exchange in a session and mints VWCs. Three of its design choices independently match ours:

1. **Session bound at the Verifiable-Presentation layer, not in the credential.** The Witness issues a
   challenge nonce; parties wrap their VRC in a VP signed over that challenge. "The credentials
   themselves can be kept simple and clean." → This is our **purpose-in-the-challenge** pattern
   (repurposed challenge/response carries the *what/when*), arrived at separately.
2. **`witnessContext { event, sessionId, method }`.** → Our **Witness-as-session-recorder**, verbatim.
3. **Two separate credentials (VRC + VWC), each independently verifiable** — not one multi-signed
   credential. → Our **"multi-sig done differently / N single-sig leaves"** insight. DTG confirms the
   separate-but-linked approach is the idiom, not native multi-sig.

The "fair witness authorized by virtue of a Community Credential" is the key to delegation (next).

## 6. Where delegation authority lives — the answer to the standing-Witness question

Earlier we asked: *is there a level of delegation where the Witness acts without a Signet
confirmation?* DTG gives the structurally-correct answer:

- **The Witness's authority to act at all** = it holds a **membership/community credential** (a VMC,
  i.e. our delegation). That credential is the Sovereign/community signing the envelope **once**
  (control plane).
- **What the Witness may do, and how far** = the **trust registry**, not the credential. The registry
  maps the W-DID → role, acceptable scope, and **assurance level**. Below the line the Witness acts on
  its standing credential; above it, the Warden's release decision (reading the registry) requires a
  Signet-cosigned approval (the relay we built).

This makes the registry **two-sided** — and folds in the platform/location/condition idea:

- **Outward registry** (the HATPro adopt): a verifier trusts a *registry of issuers* —
  `issuerAuthorized(issuer, schema)`.
- **Inward registry** (the Sovereign's own): each **Witness W-DID** carries an **assurance profile**,
  so autonomy is graded by **platform** (TEE server vs phone vs browser ext.), **location** (home LAN
  vs public internet), and **condition** (attested boot / health-check / recent human presence).
  Because "condition" is dynamic, entries are short-TTL or evaluated at query time — a Witness that
  fails a check or roams to an untrusted network is **downgraded automatically** (continuous
  authorization, CAE-style), without revoking its identity. This pairs 1:1 with **per-device
  Witnesses** (milestone W): each device-Witness DID is one registry entry.

So: the same TRQP primitive governs both "whom we trust to issue to us" and "which of our own agents
we trust to act, and how far." One mechanism, two directions — and it is exactly DTG's
thin-credential/fat-registry split, turned inward.

> **Status: built (2026-06-29).** `packages/core/src/trust-registry.ts` adopts the TRQP v2.0 shape
> from `archon-trust-registry` (`POST /authorization {authority_id, entity_id, action, resource}` →
> `{authorized, message}`) behind a `TrustEvaluator` seam: `HttpTrustRegistry` consumes a remote
> registry (outward, the guild/HATPro registry on :4260); `GroupTrustRegistry` runs one in-process
> over **Archon groups** (inward), authorizing **per `(action, resource)`** — finer than
> archon-trust-registry's per-role model, which is what grading autonomy needs. `verifyProof` gained a
> `trustRegistry` option (issuer trusted if in the static list **or** authorized by the registry).
> `npm run e2e:trust-registry` (PASS, live) shows both: **outward** — a verifier trusts the registry
> with *no* hardcoded issuers (before grant rejected, after `grantAuthorization` verified); **inward**
> — a Witness's `present`+`HIGH` clearance granted (act alone) then revoked (auto-downgrade to
> relay-to-Signet). Note: a registry-trusted proof uses a **schema-only challenge** (open issuer set);
> the registry decides issuer trust post-disclosure, since the verifier can't enumerate issuers up
> front.
>
> **Wired into the projector (2026-06-29).** `makeWitnessProjectorHandler` takes an optional
> `ProjectorAutonomy { registry, witness, witnessDid, sensitivityFor }`. On a proof-request the Witness
> derives the disclosure's **sensitivity from local policy** (never from the verifier), asks the inward
> registry `(witnessDid, present, <level>)`, and: if cleared, **presents a credential it holds on its
> own** — no Signet, no proof-of-human (the standing grant is the authority); if above its ceiling, it
> **relays to the Signet** (the milestone-W path). `npm run e2e:inward-registry` (PASS, live) shows
> both over DIDComm: a LOW request the Witness fields alone (presentation carries no `humanProof`); a
> HIGH request it relays, returned with the Signet's `humanProof`. This closes the standing-delegation
> loop end-to-end: the Sovereign signs the envelope once (registry membership = the standing grant),
> and the Signet is consulted only above the line.
>
> **Registry CLI (`packages/registry`).** Operates the registry: `bind` / `grant` / `revoke` /
> `check` / `list` over the Archon-group store, and `serve` — a dependency-free TRQP v2.0 HTTP endpoint
> (`POST /authorization`, `/metadata`, `/health`) wire-compatible with `archon-trust-registry`, so any
> TRQP client (including our own `HttpTrustRegistry`, or HATPro's verifiers) can query it. Smoke-tested
> live: grant → `check ✓` / serve → `curl /authorization` returns the expected `{authorized}`.
>
> **Cross-project interop proven (2026-06-30).** `npm run interop:registry` (`scripts/interop-http-registry.ts`)
> points our `HttpTrustRegistry` at the **live `archon-trust-registry`** ("HATPro Trust Registry", a
> different codebase) on `:4260` and gets correct role-scoped answers over the wire: an admin entity is
> authorized to `issue`+`verify`; a `member` entity is refused `issue` ("Role 'member' is not authorized
> for action 'issue'") but allowed `verify`; a non-member is refused. This is the same client
> `verifyProof` uses, so Hearthold can trust an ecosystem registry it did not build. Interop note: the
> reference registry **requires** `authority_id` on every query (our client always sends it; our own
> `serve` treats it as optional) — bidirectional compatibility holds.

## 7. Open design forks

1. **Capability token model.** DTG's relationship layer says *nothing* about the on-the-wire capability
   token. For the standing envelope we still choose: **UCAN** (JWT, attenuated chains, offline,
   revocable — the pragmatic agent-delegation default; "transfer authority without transferring keys")
   vs **ZCAP-LD** (LD-proof/VC-native) vs **OAuth RAR** `authorization_details` as the *vocabulary* for
   allow/deny/actions/limits. Not mutually exclusive: RAR for vocabulary, UCAN/ZCAP for the token.
2. **Multi-party: proof-sets vs bound-credentials.** The IETF draft `draft-herman-vtc-proof-sets`
   models a multi-party credential as **one credential with a proof set** (Notary→Initiator→Responders,
   `add-proof-set-chain`). The DTG cred-tf v0.3 spec instead keeps **separate credentials bound at the
   VP layer**. These are two different idioms for the same goal; we lean to the latter (it's what
   Archon challenge/response already does), but should pick deliberately.
3. **ZKP posture.** DTG makes **ZKP-by-default** the privacy stance (R-DID-per-connection, predicate
   proofs). Hearthold's audience keeps ZK *off the critical path* for now; we stay format-agnostic and
   note DTG's default as the eventual P5 direction, not a v1 requirement.
4. **R-DID-per-relationship cost.** DTG's privacy rule = a fresh DID per counterparty. We already do
   per-device Witness DIDs; per-*relationship* DIDs multiply DID creation on the registry — a cost
   question for the hyperswarm registry (§8).

## 8. Prototype: VWC on Archon — verified live (2026-06-29)

`packages/core/src/dtg.ts` + `scripts/proto-vwc.ts` (`npm run proto:vwc`) issue the witnessed-VRC
pair on the live node: the Sovereign mints a **VRC** to a counterparty; the **Witness (W-DID)** issues
a **VWC** about the Sovereign, digesting the VRC and recording `witnessContext`; we read it back and
present it through the prove flow. **All checks pass.** Findings:

- **VC 2.0, natively.** Archon emits `@context: https://www.w3.org/ns/credentials/v2` with
  `validFrom`/`validUntil`. (Answers old Q#1: yes, 2.0 — no 1.1 fallback needed.)
- **The DTG type hierarchy round-trips.** `bindCredential` returns a full credential object;
  mutating `type` to `["VerifiableCredential","DTGCredential","WitnessCredential"]` and `@context`
  before `issueCredential` persists exactly. **Nested `credentialSubject` (the `witnessContext`
  object) round-trips intact.** (Answers old Q#2: yes.)
- **A VWC is a first-class Archon credential.** It presents and verifies through `createChallenge`/
  `createResponse`/`verifyResponse`; the verifier reads the full `witnessContext`, trusting the W-DID.
- **Two quirks observed:**
  1. `bindCredential` injects `…/credentials/examples/v2` into `@context` by default — we strip it for
     a clean DTG credential (`withDtgContext`). *Q for macterra: can the examples context be omitted?*
  2. Proof suite is **`EcdsaSecp256k1Signature2019`**, where DTG's examples use
     `Ed25519Signature2020`. A DTG verifier must accept secp256k1 — an interop note, not a blocker.

So the relationship layer (VRC) and our Witness's core output (VWC) run on Archon **today**, unchanged.

## 9. Questions for Archon (macterra)

Collected so the maintainer can pick what to pull upstream. Q#1/Q#2 are now **answered by the
prototype** (§8) and kept here for the record.

1. ~~**VC Data Model 2.0.**~~ **Answered: yes**, Archon is 2.0-native (`validFrom`/`validUntil`).
2. ~~**Custom `type` arrays + `@context`.**~~ **Answered: yes**, via mutating the bound credential
   before issue; nested `credentialSubject` round-trips. Minor: can the default `examples/v2` context
   be suppressed at issuance rather than stripped after?
3. **Proof sets / multiple signers on one VC.** Archon's proof is a single `EcdsaSecp256k1Signature2019`
   object — no `add-proof-set-chain` (N proofs on one credential). Confirms we use the
   separate-credentials-bound-by-VP idiom (VRC + VWC), as the DTG cred-tf spec does. Please confirm
   that's the recommended Archon pattern (vs the IETF VTC proof-set draft).
4. **Selective disclosure / ZKP.** Today `verifyResponse` discloses the full credential. Any roadmap
   for predicate/SD presentation (BBS+, SD-JWT-VC)? Determines how soon DTG's ZKP-default is reachable.
5. **DID-per-relationship cost.** Is a fresh `did:cid` per counterparty (R-DID rule) cheap enough on
   the hyperswarm registry to be routine, or should we scope R-DIDs to higher-value relationships only?
6. **Trust registry as the policy plane.** *(Partly answered — §6 build.)* We reuse the TRQP wire
   shape and back it with Archon groups, authorizing **per `(action, resource)`** rather than per-role.
   Open: archon-trust-registry today maps role→actions and passes `resource` through without matching
   it to storage — would you take a **per-resource binding** upstream (a group per `(action,
   resource)`)? And for the inward registry's **dynamic condition**: model it as **live group
   membership** a posture daemon updates (what we prototyped — grant/revoke), or as a **short-lived
   posture credential** the registry references? This is the main fork still open for the inward side.
7. **Capability primitive.** Should Archon grow a **native attenuated-delegation object**, or do we
   layer **UCAN/ZCAP** on top of the existing VC + challenge/response? This is the §7.1 fork; we'd
   rather model proper Archon usage than bolt on a token Archon doesn't want.
8. **Interop proof suite.** secp256k1 vs the Ed25519 in DTG examples — is a verifier expected to handle
   both, and does Archon plan any other suites for cross-ecosystem DTG interop?

## References

- DTG WG — https://lf-toip.atlassian.net/wiki/spaces/HOME/pages/257785857/
- DTG credentials task force — https://github.com/trustoverip/dtgwg-cred-tf (`dtg.md` v0.3,
  `witnessed_vrc_flow.md`)
- VTC proof sets (IETF draft) — https://datatracker.ietf.org/doc/html/draft-herman-vtc-proof-sets-01
- TRQP v2.0 — https://trustoverip.github.io/tswg-trust-registry-protocol/approved/
- UCAN — https://ucan.xyz/specification/ · ZCAP-LD — https://w3c-ccg.github.io/zcap-spec/
- OAuth RAR (RFC 9396), GNAP (RFC 9635), OIDC CIBA · txn-challenge — see
  [standards-alignment.md](standards-alignment.md)
- Vouchsafe (capability graph, offline) — https://arxiv.org/pdf/2601.02254
