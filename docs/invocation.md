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

### 5.2 The invocation act

The Emissary invokes over an **authcrypt** envelope (sender already proven), presenting the capability chain
and an act carried under a single-use `txn`, with a challenge/response holder proof (a per-act signature is a
further hardening):

```jsonc
{
  "type": "hearthold/invocation",
  "capability": { /* the delegated capability, whole, chained to a Sovereign root */ },
  "act": {
    "action": "prove",
    "target": "resided in FR during 2026-H1",
    "args": { "reveal": [0,2], "validForMinutes": 10, "recipient": "did:cid:<verifier>" },
    "nonce": "<warden-minted>",               // act-binding (mirrors SignedKbRequest)
    "txn": "<uuid>"
  },
  "invocationProof": { /* Emissary signs act+nonce (a carried JWS); the invocation purpose is in the body */ },
  "discharges": [ /* Signet discharge(s), bound to this txn, when a requiresDischarge caveat is present */ ]
}
```

### 5.3 The Warden as reference monitor

Generalize `MeshWarden.admit` (already a genuine reference monitor: mandatory, per-request, version-pinned,
fail-closed) into `verifyInvocation`. On every invocation, in order — **deny on any failure:**

1. **Transport identity.** authcrypt `metadata.authenticated` ⇒ sender = Emissary DID. (Reject unauthenticated.)
2. **Capability chain.** `verifyAttenuationChain(capability)` — walks to a Sovereign-signed root; each hop's
   subset assertion verified; chain length bounded; not expired; **the leaf's `controller` == the
   authenticated sender.**
3. **Act ⊆ caveats.** `action ∈ allowedAction`; `target` within `invocationTarget`; requested `kind ∈
   caveats.kinds`; artefact `sensitivity ≤ caveats.ceiling`; **owner scoping = `caveats.owner`** (not any
   request field).
4. **Discharge (consent).** If `requiresDischarge` is present, require a discharge signed by the **caveat's
   designated Signet**, **bound to this `txn`** (the macaroon `PrepareForRequest` binding — this *is* the
   `txn`-echo the audit found missing). Feed the achieved tier into `decideRelease`.
5. **Status.** `credentialStatus` check on the capability (`status-list.ts`, fail-closed) — revoked ⇒ deny.
6. **Freshness.** Nonce fresh + single-use burn (`single-use.ts`).

Only then perform the act — and `assembleEvidence` is scoped to `caveats.owner` + `caveats.kinds` (not
`store.list()` over the whole vault).

### 5.4 Why this closes finding A structurally

The recipient and the approver are no longer strings the requester supplies. The **approver** is the Signet
the capability's `requiresDischarge` caveat *designates* (the data owner's), and the discharge is **bound to
the specific act** — so a captured/relayed approval can't be reused, and no requester can name themselves as
approver. The **owner scoping** comes from `caveats.owner`, not `req.subjectDid`. Designation and authority
are fused in the capability. The confused deputy has nowhere to stand.

**The binding rule (what makes this enforcing, not advisory).** Everything the Warden enforces is read from the
*verified, commitment-bound chain* — never from `inv.capability.credentialSubject`, which is an unauthenticated
wire object. The invocation must present the disclosure for **every** hop (the 256-bit salt that binds each
commitment can only be produced by decrypting the hop — i.e. by holding it), and the caller is bound to the
leaf's **issuer-signed holder DID** by Archon **challenge/response** (`verifyResponse`), not by a self-asserted
`controller`. Omitting the disclosure, forging the body, stripping the status pointer, deleting a
`requiresDischarge` caveat, or proving control of the *wrong* DID all fail closed — the red test
`scripts/e2e-invocation-confused-deputy.ts` exercises each.

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
authcrypt says it's the Emissary; the chain says the Sovereign granted `location ≤ MEDIUM over memberX`; the
act asks for `location` over memberX ✓; a MEDIUM disclosure needs a discharge from **memberX's** Signet bound
to this txn — memberX approves; status ✓; nonce burned; evidence assembled **over memberX's location only**.
An attacker with a delegation for `image` over memberY cannot form this request, cannot name memberX as
owner, and cannot supply the discharge. **The step-up cannot be bypassed and cross-member data cannot leak.**

---

## 7. Mapping to Karp's four criteria

| Criterion | Before | After |
|---|---|---|
| **1. The act is the signed object** | Request unsigned; approval portable across audience/recipient/TTL/mode. | The caller is bound to the chain's holder by challenge/response, the disclosure is commitment-bound, and each act is single-use by `txn`; the discharge is bound to that `txn`. *(A per-act signature over a Warden nonce is a further hardening.)* |
| **2. Something has to ask permission** | `decideRelease` a pure probe; no revocation; no reference monitor on the disclosure path. | `verifyInvocation` is a mandatory reference monitor; `credentialStatus` fail-closed; consent via bound discharge. |
| **3. Attenuation with teeth** | `attenuation.ts` unused; evidence path passed a boolean; whole-vault `list()`. | Chain verified at invocation; act ⊆ caveats; owner+kind scoping enforced Warden-side. |
| **4. Designation is authority** | Every subject/recipient/approver named by string → confused deputy. | Authority is an unforgeable capability chained to a Sovereign root; the approver/owner are *designated by the capability*. |

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
