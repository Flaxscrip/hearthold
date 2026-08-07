# Invocation on Hearthold

*Capability-based authority for the Emissary — turning a recognized identity into a held, attenuated, invocable capability.*

**Status:** design, adopted and built — **entirely at the app layer.** The capability/invocation layer lives
in Hearthold on Archon's existing primitives, with no upstream dependency. **Audience:** Hearthold engineering;
also the reference we bring to the Archon architect and the DIF Trusted AI Agents WG.

---

## 1. Why this document

Hearthold has **strong delegation and immature invocation.** The Sovereign can grant the Emissary a scoped,
revocable delegation; the Warden holds a good release ladder, a pairwise mint, a fail-closed classifier. But
at the moment authority is *exercised*, the Emissary presents an **identity** (its `did:cid`) and the Warden
looks it up in a table — `delegations.isAuthorized(fromDid)` returns a boolean, `kindsFor(fromDid)` returns a
list. The Emissary carries no authority; it is *recognized*. In practice it behaves like a **smart session
cookie**.

That is the exact shape Alan Karp measures against and finds wanting — and it's the shape that produced
finding A of the invocation audit (the requester names the approver and recipient by string; the Warden acts
on it — a textbook **confused deputy**). It is also what Karp told the DIF WG the HDP agentic-delegation draft
lacks: *"It doesn't include invocation."*

This document specifies how Hearthold delivers invocation: the Emissary stops being recognized and starts
being **empowered** — it holds an unforgeable, attenuated **capability** and presents it at each act, the
Warden verifies that capability at the point of use, and the authority to disclose to a party is **designated
by the capability, never named in a mutable request field.** Doing this is simultaneously the security fix
(it closes finding A structurally) and the positioning: Hearthold becomes a working demonstration of the
invocation the field is missing.

---

## 2. What invocation is (and why delegation is not enough)

Two distinct acts:

- **Delegation** — *handing out* authority. "This agent may act within these bounds." Issuance-time. This is
  what VCs, OAuth scopes, and HDP do.
- **Invocation** — *exercising* authority. "Is **this** act, right now — this action, this target, these
  args — within the bounds of a capability the actor actually holds, checked by the resource at the point of
  use?"

Karp's thesis, in his own words: the confused deputy exists because *"the invoker designates the thing to
work on while the deputy uses its own permission,"* and it *"would fail if the invoker had to provide an open
file handle, which combines designation and authorization."* A **capability** is that open file handle —
designation and authority fused into one unforgeable token. His concrete recommendation, also verbatim:
authorization tokens need *"a required type that could be either 'credential' or 'authorization' to keep the
use cases distinct."*

HDP proves the point by contrast. Its own text: *"HDP is designed to provide provenance and tamper evidence,
not runtime enforcement… HDP creates an evidence trail, not a capability boundary,"* and *"applications
requiring runtime enforcement MUST implement it at the application layer."* HDP records who was authorized;
**Hearthold is the boundary that enforces it at the act.** We are the application layer HDP defers to.

---

## 3. The Trinity is an object-capability triad

The three Hearthold roles map cleanly onto the classic ocap triad — the Emissary's underuse was that we never
gave it capabilities to carry:

| Role | ocap role | Job |
|---|---|---|
| **Sovereign / Signet** | **Controller** (root) | Owns the root capability; delegates attenuated capabilities to the Emissary; co-signs (discharges) the ones a human must approve. |
| **Warden** | **Resource + reference monitor** | Holds the data; verifies every invocation against the presented capability at the point of use; fail-closed. |
| **Emissary** | **Invoker / delegate** | Holds attenuated capabilities; exercises them in the world; can attenuate-and-hand-off to a third party. |

This is the Emissary coming into its own. A world-facing agent's whole purpose is to *act under delegated
authority* — which means holding capabilities and invoking them, not presenting an identity to be recognized.

---

## 4. The Archon substrate (what we build on)

Archon has **no capability layer** — authorization is ownership-proof + group-ACL + credential-challenge, and
there is no ZCAP-LD, no `capabilityInvocation`/`capabilityDelegation` proof purpose, no attenuation. The one
macaroon implementation (Drawbridge L402) is a payment paywall — first-party caveats only, single-issuer,
non-delegable. So the capability/invocation layer **is ours to build** at the app layer. But we build on solid
primitives:

- **authcrypt sender-authentication is cryptographically real.** `keymaster.unpackDidComm` sets
  `metadata.authenticated` true only when the envelope was produced by the private key matching the sender's
  `skid` in their resolved DID document (the KEK is derived from `Zs = X25519(recipientPriv, senderPub)`; a
  forged sender fails decryption). **So the Emissary's DID is trustworthy at the transport, before any
  capability check.** An invocation never needs to re-prove *who* is invoking — the envelope proves it.
  - Caveat: authcrypt is **authenticated but repudiable** (proven to the recipient, not to third parties).
    When an invocation must be **third-party auditable** (e.g. an evidence disclosure a verifier will later
    cite), add an inner JWS (`sign: true`) for non-repudiation. Rule of thumb: **authcrypt for
    Emissary→Warden invocation** (the Warden is the verifier — repudiable is fine); **+JWS whenever the
    Warden mints something a third party audits.**
- **VCs are signed, revocable grants** (`issueCredential` / `acceptCredential` / `revokeCredential`). This is
  the substrate for the capability *object*, typed `authorization` per Karp.
- **Groups** (transitive `testGroup`) — the coarse roster ("who may hold a capability at all"), not the
  authority itself.
- **Temporal key resolution** — a proof is verified against the signer's DID document *as of signing time*, so
  capability proofs survive Sovereign key rotation for free.
- **Challenge/response VP + trusted-issuer allowlist** — the discharge/consent presentation surface.

And one piece we already have and merely need to *wire in*: `packages/core/src/attenuation.ts` — salted
authority commitments, version-pinned parent refs, per-hop signed subset assertions. The audit called it
"good code with zero call sites." It is the **chain verifier** this design needs; it stops being a research
artifact the moment it verifies a real invocation.

---

## 5. The design

### 5.0 Shipped mechanism — capabilities as VCs (read this first)

The implementation represents a capability as a **Sovereign-issued Verifiable Credential** and presents it
through Archon's native **credential-request challenge/response** — the same primitive `prove.ts` uses for
evidence, applied to authorization. This is simpler and *sound by construction*, and it is what the code and
tests actually do:

1. **Issue.** The Sovereign issues the Emissary a `HearthholdAuthorization` VC whose `credentialSubject` **is**
   the capability — `{ invocationTarget, authority: {operations, resources}, caveats: {ceiling, owner,
   audience, expires, singleUse, requiresDischarge, status} }` (`issueScopeCapability`). The schema is
   content-addressed, so every wallet derives the same schema DID (`ensureAuthorizationSchema`).
2. **Request.** The Warden's invocation challenge *requests that credential*, constrained to the Sovereign as
   issuer: `createChallenge({ credentials: [{ schema, issuers: [Sovereign] }] })` (via `requestProof`).
3. **Present.** The Emissary answers with a presentation (`createResponse`) — the invocation carries only that
   `presentation` DID plus the `act` (and any discharges). There is **no capability body on the wire**.
4. **Verify + enforce.** `verifyResponse`/`verifyProof` returns the disclosed scope, the **responder** (proven
   holder control), and issuer-trust in one step. The monitor enforces the act against that **verified** scope
   — owner, ceiling, audience, revocation status and consent obligations all come from the issuer-signed VC.
   An attacker cannot forge the Sovereign's signature over a scope, cannot present a VC it does not hold, and
   cannot invoke as a holder it cannot control. The confused deputy is unrepresentable.

The subsections below describe the general capability model; the **attenuation chain** (`attenuation.ts`) is
retained for **multi-hop delegation** (Phase 4 — Emissary → third party, attenuated), which the single-hop VC
ceremony above does not cover. For single-hop grants (all of today's paths) the VC ceremony is the mechanism.

### 5.1 The capability object

A Hearthold capability is a VC, **explicitly typed as authorization** (never an overloaded credential). The
delegation/invocation *purpose* is carried in the credential body and enforced by Hearthold, since Archon
proofs only use `proofPurpose: authentication` today. The `credentialSubject`:

```jsonc
{
  "type": ["VerifiableCredential", "HearthholdAuthorization"],
  "authorizationType": "capability",          // Karp: keep authorization ≠ credential
  "id": "urn:uuid:…",                          // opaque
  "controller": "did:cid:<holder>",            // who may invoke / further-delegate (the Emissary)
  "parentCapability": "did:cid:<root-or-parent-cap>",
  "invocationTarget": "hearthold:vault:<scope>",   // the resource this authority applies to
  "allowedAction": ["prove"],                  // ⊆ parent's actions
  "caveats": {
    "kinds": ["location"],                     // ⊆ parent
    "ceiling": "MEDIUM",                        // ≤ parent (Sensitivity)
    "owner": "did:cid:<member>",               // WHOSE data — designates the subject, not requester-supplied
    "audience": "did:cid:<verifier>|null",     // bound recipient, if any
    "expires": "2026-09-01T00:00:00Z",         // ≤ parent, ≤ policy cap
    "singleUse": true,
    "requiresDischarge": [                      // third-party caveat (macaroon-style)
      { "by": "did:cid:<owner-signet>", "predicate": "cosign(act)", "location": "<signet-endpoint>" }
    ]
  },
  "proof": { /* keymaster VC proof; the delegation purpose is carried in the credential body */ }
}
```

Attenuation is **monotonic**: a delegated capability may only narrow — actions ⊆ parent, `kinds` ⊆ parent,
`ceiling` ≤ parent, `expires` ≤ parent. Never broaden.

### 5.2 The invocation act (as shipped)

The Emissary invokes over an **authcrypt** envelope (sender already proven). The wire carries **no capability
body** — only the `presentation` (a `createResponse` DID answering the Warden's challenge) and the `act` under a
single-use `txn`. The scope is read from the *verified* presentation, never from the wire (`capability.ts`
`CapabilityInvocation`):

```jsonc
{
  "type": "hearthold/invocation",
  "version": "0.4.0",
  "presentation": "did:cid:<createResponse — answers the Warden's challenge, discloses the Sovereign's scope VC>",
  "act": {
    "action": "prove",
    "target": "hearthold:vault:location",
    "args": { "claim": "resided in FR during 2026-H1", "spec": { "kind": "location" }, "reveal": [0,2] },
    "nonce": "<uuid>",
    "txn": "<uuid>"                            // single-use; burned on success
  },
  "discharges": [ /* Signet discharge(s), bound to this txn, when consent is required */ ]
}
```

The `presentation` is minted by the Emissary answering a **Warden-minted challenge** (§5.3 step 1); the Emissary
obtains one with `hearthold/challenge-request`. `act.nonce` is carried for future per-act signing but is not yet
load-bearing — the anti-replay teeth are the Warden challenge (single-use) and the `txn` burn.

### 5.3 The Warden as reference monitor (as shipped)

`resolveInvocation` + `authorizeInvocation` (`invocation-monitor.ts`) are the mandatory, per-request,
fail-closed monitor. On every invocation, in order — **deny on any failure:**

1. **Presentation + audience binding.** `verifyProof(presentation, { trustedIssuers: [Sovereign], schema:
   HearthholdAuthorization })` — the disclosed scope VC must be Sovereign-issued and satisfy the challenge. The
   answered challenge must be one the **Warden minted** (fresh, single-use — `ChallengeStore.gate`), so a
   captured presentation is not a bearer token.
2. **Holder control.** `responder` (proven by the response's own signature) must equal the credential
   **subject** the Sovereign signed — possession of the VC plaintext is *not* authority — and the authcrypt
   sender (`fromDid`) must equal that holder.
3. **Act ⊆ authority.** `action ∈ authority.operations`; `target` within `authority.resources`. Designation is
   authority — no ambient lookup, no wire body.
4. **Status.** If the scope carries a `credentialStatus` pointer, resolve it fail-closed (`status-list.ts`) —
   revoked or unavailable ⇒ deny.
5. **Replay + lifetime.** `txn` unseen (burned on success); `caveats.expires` in the future; a `singleUse`
   capability not already spent (burned on success).
6. **Ceiling + kind.** The assembled `sensitivity ≤ caveats.ceiling`; the requested `spec.kind ∈ caveats.kinds`
   (when scoped). Denials here are message-normalized so they don't leak that an artefact exists above the
   holder's clearance.
7. **Consent.** A `requiresDischarge` caveat **or** the Warden's sensitivity policy (`requiresHumanAt`, default
   MEDIUM) requires a discharge signed by the **designated owner's Signet**, **bound to this `txn`+predicate**
   (the macaroon `PrepareForRequest` binding). Obtained over the direct Warden↔Signet channel — the Emissary is
   never on it.

Only then is the act performed — and `assembleEvidence` is scoped to the **verified** `caveats.owner` (not
`store.list()` over the whole vault).

> **Not shipped (Phase 4).** `attenuation.ts` / `capability-chain.ts` (the salted-commitment, multi-hop
> **delegation** chain — `verifyAttenuationChain`, per-hop subset assertions) is retained for Emissary→third-party
> attenuation and has no call site on the shipped single-hop path. Where earlier drafts of this document described
> a chain walk or a 256-bit disclosure salt as the enforcing mechanism, that was aspirational: the shipped monitor
> is a single `verifyProof`, and the protection is sound by construction, not by a chain.

### 5.4 Why this closes finding A structurally

Everything the Warden enforces — `owner`, `ceiling`, `audience`, `kinds`, `status`, `requiresDischarge` — is read
from `verifyProof`'s **issuer-signed disclosed claims**, never from a wire body (there isn't one). So altering a
caveat, stripping the status pointer, deleting a discharge caveat, or naming yourself as owner/approver are not
*refused* — they are *unconstructible*: you cannot forge the Sovereign's signature over a scope. The **holder**
is the challenge/response `responder`, bound to the credential **subject** and to the authcrypt sender — so
possession of a copied VC is not authority. The **approver** is the Signet the caveat (or the Warden policy)
*designates*, and its discharge is bound to the act's `txn` — a captured approval can't be reused, and no
requester can name themselves.

The red tests exercise this against the real ceremony: `e2e-invocation-confused-deputy` (no presentation,
self-issued scope, replay by a non-holder, a copied VC under the attacker's own DID — all refused);
`e2e-invocation-challenge` (a replayed or self-minted challenge refused); `e2e-invocation-human-gate` /
`e2e-invocation-discharge-didcomm` (a SEALED-ceiling capability with no caveat cannot disclose MEDIUM+ without
the owner's live consent).

---

## 6. Worked example — evidence disclosure, before and after

**Before (ACL / cookie).** Emissary → `{ evidence-request, claim, spec:{kind:location},
subjectDid:<attacker>, recipientDid:<attacker> }`. Warden: `isAuthorized(fromDid)` → true; routes step-up to
`req.subjectDid`; attacker self-signs `level:2`; verification passes because signer == named approver;
`assembleEvidence` runs over the whole vault; scroll minted encrypted to the attacker. **HUMAN collapses to
STANDING.**

**After (capability / invocation).** Emissary holds a capability delegated by the Sovereign:
`{invocationTarget: vault:<memberX>, allowedAction:[prove], caveats:{kinds:[location], ceiling:MEDIUM,
owner:<memberX>, requiresDischarge:[{by:<memberX-signet>}]}}`. It invokes with a nonce-bound act. The Warden:
authcrypt says it's the Emissary; the verified scope VC says the Sovereign granted `location ≤ MEDIUM over memberX`; the
act asks for `location` over memberX ✓; a MEDIUM disclosure needs a discharge from **memberX's** Signet bound
to this txn — memberX approves; status ✓; nonce burned; evidence assembled **over memberX's location only**.
An attacker with a delegation for `image` over memberY cannot form this request, cannot name memberX as
owner, and cannot supply the discharge. **The step-up cannot be bypassed and cross-member data cannot leak.**

---

## 7. Mapping to Karp's four criteria

Grades are the third audit's (2026-08-07), not our own.

| Criterion | Before | After (shipped) |
|---|---|---|
| **1. The act is the signed object** (C−) | Request unsigned; approval portable across audience/recipient/TTL/mode. | The presentation answers a single-use **Warden-minted** challenge and each act is single-use by `txn`; the discharge is bound to that `txn`+predicate. The act itself is not yet signed (`act.nonce` is carried, not enforced) — a per-act JWS is the remaining hardening. |
| **2. Something has to ask permission** (B−) | `decideRelease` a pure probe; no revocation; no reference monitor on the disclosure path. | `resolveInvocation`/`authorizeInvocation` is one mandatory, fail-closed door; `credentialStatus` fail-closed; consent is a **Warden policy** (`requiresHumanAt`), not an issuer's option, obtained via a bound discharge over the wired Signet channel. |
| **3. Attenuation with teeth** (B−) | `attenuation.ts` unused; evidence path passed a boolean; whole-vault `list()`. | Caveats come from an issuer-signed VC, so they bite: act ⊆ authority, `ceiling`, `kinds`, `expires`/`singleUse` all enforced at use; assembly scoped to the verified `owner`. Multi-hop chain attenuation is Phase 4 (§5.3). |
| **4. Designation is authority** (B) | Every subject/recipient/approver named by string → confused deputy. | There is **no wire capability body to forge**; authority is a Sovereign-issued VC, the holder is the challenge/response responder bound to the credential subject, and the approver/owner are designated by the VC. |

**Residuals, named honestly (Karp's register):**
- **Ambient authority remains** in `config.sovereignDid` fallbacks and the localhost control plane (a local
  process is treated as the Sovereign on a default node). Full "no ambient authority" is out of scope here;
  the control-plane session work (the family-model plan) narrows it.
- **Repudiable authcrypt** is sufficient for Emissary→Warden invocation; third-party-auditable acts must add
  JWS. This is a per-path decision, documented, not a silent gap.
- **Single-box governor with root** over a live session is not absolutely preventable in software; it is made
  to cost cryptography and leave signed evidence (the guardianship threat-model line).

---

## 8. Build plan (app-layer, landable)

Each phase lands with an e2e against the live node (`HEARTHOLD_REGISTRY=local`, isolated data root), and a
red test `e2e-invocation-confused-deputy.ts` that proves the finding-A attack fails the **capability** way,
not merely an ACL patch.

- **Phase 0 — capability types + typing.** New `packages/core/src/capability.ts`: the `HearthholdAuthorization`
  VC shape, `authorizationType`, mint helpers (`mintRootCapability`, `delegateCapability`) over
  `keymaster.issueCredential`. No behavior change.
- **Phase 1 — delegation + attenuation wired.** Wire `attenuation.ts` as the chain verifier over capability
  VCs; `delegateCapability` enforces the subset at issuance (courtesy) and `verifyAttenuationChain` enforces
  it at invocation (authority). Sovereign root capability over the vault. *(Subsumes audit #10.)*
- **Phase 2 — invocation act + Warden reference monitor.** The `hearthold/invocation` message;
  `verifyInvocation` (generalized from `MeshWarden.admit`); rebuild the evidence path to require a capability
  instead of `subjectDid` + boolean; scope `assembleEvidence` to `caveats.owner` + `caveats.kinds`; wire
  `credentialStatus`/`status-list` + single-use nonce. *(Subsumes audit #1, #3, #5, #6.)*
- **Phase 3 — discharge caveat (consent).** `requiresDischarge` third-party caveat; the Signet produces a
  discharge **bound to the txn**; MEDIUM+/SEALED route through it; retire the requester-named approver and the
  self-certified `approvedLevel`. *(Subsumes audit #4, #7.)*
- **Phase 4 — the Emissary as delegator.** Emissary attenuate-and-hand-off: mint a further-narrowed capability
  to a verifier (bound `audience`), so a third party can receive one specific disclosure without the Warden
  pre-knowing them. The world-facing payoff.

**Invariant (registry hygiene):** every capability VC, root, and discharge is minted on `registry:
config.registry` (= `local` in dev); e2e asserts it. Never default to hyperswarm.

---

## Sources

See also **`docs/attributions.md`** — the prior-art ledger tracking exactly what each design contributes and
where it lands in our code.

- Alan Karp, W3C public-credentials list (designation ≡ authority; the `credential` vs `authorization` type
  recommendation): <https://lists.w3.org/Archives/Public/public-credentials/2022Sep/0056.html>
- ZCAP-LD (Authorization Capabilities for Linked Data), W3C-CCG: <https://w3c-ccg.github.io/zcap-spec/>
- Birgisson et al., *Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the Cloud*,
  NDSS 2014 (third-party caveats / discharge): <https://research.google/pubs/pub41892/>
- HDP agentic-delegation draft (the delegation-only contrast):
  <https://datatracker.ietf.org/doc/draft-helixar-hdp-agentic-delegation/>
- Hearthold invocation audit (findings A/B and the four-criteria scorecard) — this repo.
