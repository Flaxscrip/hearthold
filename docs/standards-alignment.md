# Hearthold — Standards Alignment: OAuth Transaction Authorization Challenges

**Reference:** [`draft-rosomakho-oauth-txn-challenge-00`](https://www.ietf.org/archive/id/draft-rosomakho-oauth-txn-challenge-00.html)
— *OAuth Transaction Authorization Challenge* (IETF Internet-Draft).

This note reviews Hearthold's private-data **generation → storage → access** model against the
draft, records where we align, where the draft's criticisms apply to us, and where our model goes
further. It then commits the resulting requirements into the design of the evidence flow
(`/evidence`, step 5 of the v1 plan). The intent is that Hearthold serve as a concrete reference
for these patterns on Archon `did:cid` infrastructure.

## The draft's thesis

A valid access token proves the caller **holds credentials** — not that an **approving party
approved a concrete operation**. The draft adds a *transaction authorization challenge*: a signed
JWT a protected resource returns when an operation needs transaction-specific approval. It carries
the operation (`authorization_details`), a unique transaction id (`txn`), and an integrity-protected
human-readable `reason`. It flows protected-resource → agent → client → authorization server, which
obtains approval and mints a **short-lived token bound to that exact `txn`**. The sharpest rule
(§7.7): the relaying **agent is not trusted to describe the transaction** — what the approver sees
must derive from the *signed* challenge, never the agent's summary.

## Architecture mapping

The draft's five parties collapse into Hearthold's three actors:

| Draft role | Hearthold | Notes |
|---|---|---|
| Protected Resource (issues challenge, holds data) | **Warden** | |
| Authorization Server (approves, mints token) | **Warden** | same local process — see *Advantages* |
| Approving Party | **Sovereign** | via PIN/passphrase/second-device step-up |
| Client (validates challenge) + Agent (relays) | **Emissary** | the §7.7 pressure point |
| Access token bound to `txn` | **selective-disclosure attestation VC** | our access artefact |

Two deliberate collapses: **PR + AS → Warden** (a privacy win — the authorizer is local), and
**Client + Agent → Emissary** (concentrates the §7.7 "untrusted summarizer" risk into one component
on the Sovereign's own device).

## Where Hearthold already aligns

- **Session ≠ transaction approval.** Baseline `STANDING` session vs. per-request **step-up** for
  `MEDIUM+` content (`security.ts`) mirrors the draft's credentials-vs-transaction-approval split.
- **Signed, asymmetric challenges, validated before use** (§4.3, §7.2). Archon
  `createChallenge`/`verifyResponse` is secp256k1 / `did:cid` — never symmetric, never `none`.
- **Short-lived tokens** (§5.4.8). Session token TTL = 15 min.
- **Output bound to the operation** (§7.4, §7.6). The minted attestation VC is issued for a
  specific claim and signed by the Warden (audience = Warden), analogous to a `txn`-bound token.
- **Step-up complements authentication** (draft framing) — matches our tier ladder.

## Where the draft's criticisms land on us

1. **Step-up proves *presence*, not approval of *this disclosure*.** Today step-up is a generic
   delegation challenge, not bound to the specific `EvidenceRequest`. The draft requires approval
   to bind a unique `txn` + the concrete operation, single-use (§7.4, §7.5). **Gap.**

2. **§7.7 — the agent must not summarize the transaction.** In our current shape the *Emissary*
   holds the `claim` and would render the approval prompt — i.e., the agent describing what is
   approved. That is the anti-pattern. The approver must see a description derived from the
   Warden's signed challenge. **Gap** (and the teeth behind "presence ≠ person": PIN proves the
   person; the signed Warden description proves they approve the *right thing* even if the Emissary
   app is compromised).

3. **Session token is a plain bearer token, not sender-constrained.** The draft `SHOULD`s
   sender-constrained tokens (DPoP/mTLS) for high-impact ops (§7.5). Tailscale + in-band sealing
   mitigate wire theft, but a lifted bearer token is still usable by another party. **Gap.**

4. **No single-use / replay state for high-impact disclosures** (§6.2.5). **Gap.**

5. **No capability signaling / explicit pre-disclosure decline** (§4.1, §7.9). **Minor gap.**

## Where Hearthold goes beyond the draft

- **The authorization server is local.** The draft's §7.9/§7.10 worry — the client disclosing
  privacy-sensitive transaction details to a third-party AS — does not exist for us: our AS *is*
  the Warden, on the Sovereign's hardware. Eliminated by construction.
- **Selective-disclosure output.** Their token authorizes *access to data*; our attestation VC
  proves *the fact without the source* — a stronger privacy primitive than the draft defines.
- **Zero-footprint transport + local-only AI.** Their privacy guidance is a modest "minimize and
  don't log." Our in-band sealing (no registry anchoring) and local classifier make minimization
  the default.
- **Smaller confused-deputy surface.** They split Client from Agent because the agent is an
  untrusted relay; our Emissary is the Sovereign's own trusted client. Residual risk reduces to
  "is the Emissary compromised" — exactly what requirements R2/R3 below harden against.

## Requirements adopted into the evidence flow (step 5)

These become normative for the `/evidence` implementation (currently a stub).

**Transport note (DIDComm v2).** Over DIDComm, **authcrypt** authenticates the sender DID at the
transport layer, so authentication is no longer the job of a challenge/response. Challenge/response
is **repurposed** as the *authorization* layer: an Archon challenge is extensible, so the Warden
puts the **purpose** (`txn`, the concrete claim, validity window) in it, and the responder's signed
response is a **dated, DID-attributable approval bound to that purpose**. Authcrypt is repudiable by
design (authenticated to the recipient, deniable to third parties); anything that must survive as
*portable evidence* is therefore an explicitly **signed** artefact (a signed response / VC), not an
authcrypt message.

- **R1 — Transaction binding.** Each evidence request gets a unique `txn` (à la the draft / SET
  `txn`). When sensitivity demands step-up, the Warden issues a **purpose-bearing challenge** —
  carrying the `txn` and the concrete claim. The signed response and the minted attestation VC both
  carry the `txn`; the grant is **single-use** for non-idempotent/high-impact disclosures (§7.4, §7.5).

- **R2 — Warden-authored approval (no agent summary).** The challenge carries a **Warden-signed
  `reason` + a preview of the exact attestation** to be disclosed. The Emissary MUST present that
  verbatim to the Sovereign and MUST NOT substitute its own description (§7.7). The Sovereign's
  **signed response** to that challenge is the approval record.

- **R3 — Sender constraint.** DIDComm authcrypt binds each message to the sender's key at the
  transport layer, satisfying the sender-constraint goal (§7.5) without a separate bearer token;
  any retained approval is a signed artefact bound to its `txn`.

- **R4 — Explicit decline + minimization.** The Sovereign can decline at the Emissary before a
  sensitive request proceeds; challenges and granted attestations carry the minimum necessary and
  are not logged in the clear (§7.9, §7.10).

- **R5 — Sovereign control plane (extends the draft).** The draft governs resource *access*, not
  policy *administration*. Hearthold adds a third identity — the **Sovereign**, held by the
  **Signet** app — that signs the Warden's access-control configuration (Warden verifies and fails
  safe) and **co-signs HIGH/SEALED disclosures**, carrying a graded **proof-of-human assertion**.
  This makes the draft's "approving party" cryptographic (= our `MULTIFACTOR` tier): the Sovereign's
  signed response to the purpose-bearing challenge (R1/R2) **is** the co-signature, and the
  approval description (§7.7) is provably the Sovereign's. See
  [sovereign-signet.md](sovereign-signet.md). This is where Hearthold goes beyond the draft and is
  the part most worth offering back as a reference pattern.

## Disclosure mechanism

What the Warden returns is a signed **evidence graph** (see [evidence-graph.md](evidence-graph.md)),
not an opaque token or a score. Disclosure is **issuer-attested**: the Warden is the issuer, derives
the fact, and signs it (co-signed by the Sovereign for sensitive claims), so the verifier trusts the
signature as it would any credential issuer. Field-level disclosure uses **salted-digest commitments
(SD-JWT-VC) or Merkle membership**.

## Protocol deltas implied (for reference when we build step 5)

- `EvidenceRequest` gains a `txn` (client-proposed or Warden-assigned on first `step-up-required`).
- For step-up, the Warden issues a **purpose-bearing Archon challenge** carrying
  `{ txn, reason, attestationPreview }` (the artefact the Emissary displays verbatim); the
  Sovereign's **signed response** is the approval, referenceable by DID as the evidence graph's
  `approval` node.
- The minted attestation VC includes the `txn` and a short `validUntil`; the Warden records spent
  `txn`s to enforce single-use.
- Routine (non-sensitive) submissions need no challenge: authcrypt authenticates the Witness DID,
  and the Warden checks it issued that DID an unrevoked delegation.

## Status

Design note only — no behavioural change yet. The four requirements are committed into step 5 of
[PLAN.md](PLAN.md); the security model is in [security-model.md](security-model.md).
