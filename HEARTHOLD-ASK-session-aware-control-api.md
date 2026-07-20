# Hearthold — make the Warden control API session-aware (gates the Sevenfold family model)

**From:** Sevenfold (the Table) · **Date:** 2026-07-16 · **Priority:** the single gate on all of P1.5

The live UC1/UC2 run against `:4310` closed both P1 exits — thank you. Building on it, one control-plane
change unblocks the whole **P1.5 family model** (KB Spaces / per-Sovereign Table). This ask **subsumes the
earlier one-liner** (default the marks `subjectDid`) — don't do that separately; it falls out of #2 below.

---

## The gap

The localhost control API is **single-Sovereign**: `/api/snapshot`, `/api/card/face`, `/api/triage`,
`/api/recall`, `/api/marks/*` all run as the Warden's configured Sovereign (`config.sovereignDid`). There's
no per-caller identity.

But `kb-spaces.md`'s load-bearing rule is: *"the visible set is derived server-side from the **authenticated
session DID**."* On the DIDComm / KB-login path you have that. On the **localhost control API the Table uses,
you don't.** So the Table can't act *as* a specific member, and "log into the Table as each member" (the
family smoke test) is impossible today.

Verified during the live run: `WardenStatus` carries only the *Warden's* `identity`; `snapshot()` /
`recall` take no caller; the KB-spaces machinery itself (`warden kb-spaces enable`, `kb-grant`,
`PartitionStore`, `provisionMemberPartition`) *is* shipped — it's only the control-plane session surface
that's missing.

## The ask

Make the control API accept and scope to a **session Sovereign identity**, and compute every visible set
from it:

1. **Establish / select a session** on the control plane — a member logs in (challenge/response, reusing
   the warden-console session model), or the Table presents a session token identifying the member DID.
   Whatever fits your auth model; the Table just needs a way to say *"act as member X."*

2. **Scope everything to the session DID, server-side:**
   - `snapshot` — that member's visible set (shared partition ∪ their private partition)
   - `card/face` — release decision against the session member
   - `triage` — the session member's quarantine queue
   - `recall` — union recall over the visible set; each citation carries its partition
   - `marks` — candidates / claim for that Sovereign. **This defaults the marks `subjectDid`** — the old
     one-line ask is subsumed here.

3. **Expose the session DID back to the Table** — `WardenStatus.sessionDid` (or `GET /api/whoami`) — so
   the Table knows whose view it is and drops the `VITE_SOVEREIGN_DID` deploy-time hack.

## Two data-shape additions the family UI needs

Small, additive to `@hearthold/control-types`:

- **`scope: 'shared' | 'private'` on `VaultItem`** — the card-frame partition origin. Binds the proposed
  `scope` semantic token (Fable countersigns the token semantics; Sevenfold implements).
- **`scope: 'shared' | 'private'` on `RecallCitationView`** — so Divination draft citations show
  private-vs-shared badges (match the portal's citation-scope semantics).

## Guardrail (G-grade — a leak here is a disclosure bug, not a UI bug)

The visible set MUST be computed from the authenticated session **server-side**, *never* from anything the
Table sends as content. The Table will assert isolation (no cross-member card or face ever renders), but
the real boundary is yours.

## What Sevenfold does when these land

1. Wire the session identity into the DataSource (login-as-member; drop `VITE_SOVEREIGN_DID`).
2. Implement the `scope` semantic token + citation scope badges — one clean pass (tokens.css + Card +
   theme-invariance mutation test extended).
3. Run the two-member **family smoke** (assert per-session isolation; no cross-member card/face renders).

In the interim, Sevenfold locks the Table-side isolation invariant against a **mock two-session source**,
so the rendering-side G-grade property is proven and ready before the control-plane work lands.

## Minor, separate observation from the live run

The Signet step-up caps at **180s** — tight for a live human tap (two approval windows lapsed in the run
before the third landed cleanly). Consider a longer / configurable timeout for interactive forges.

---

## Review — Fable, 2026-07-16 (endorsed, with four tightenings; posture verdict: STRENGTHENS)

Net assessment: this ask **improves** the security/privacy posture — it replaces today's implicit
control-plane identity (anything on localhost with a console session = the Sovereign; Marks subject from a
client env var) with proven per-caller identity and server-side scoping. Client-asserted identity is the
anti-pattern the KB path already eliminated; this brings the control plane up to that standard. Four
amendments before build:

1. **§1 as written is too permissive — REQUIRE proven identity.** Strike "whatever fits your auth model /
   a token identifying the member DID." A session is established ONLY by challenge/response (member wallet
   signs a Warden nonce — the shipped KB-login pattern). A session token is acceptable only as a
   server-issued handle *bound to that proof*, expiring. Identity is proven, never asserted — the same rule
   §"Guardrail" already states; make §1 obey it.
2. **Per-member Signets.** Step-ups (MEDIUM+ face, forge, SEALED) must route to the **session member's own
   approver device**, resolved by session DID. One household ≠ one Signet. Name it in scope.
3. **Session-scope the event stream.** `/api/events` SSE must filter to the session's visible set — a
   member watching another member's `submission-stored` events is a metadata disclosure (activity patterns
   are disclosures; see the registry-hygiene postmortem).
4. **Name the hidden prerequisite: vault artefact ownership.** `Artefact` carries no owner today; "the
   member's visible set" over the *vault* (not just KB partitions) requires per-artefact ownership,
   naturally attributed from the submitting Emissary's delegation chain. This is a data-model change and
   G-grade — scope it deliberately (owner field + backfill for the existing single-Sovereign vault:
   default-attribute to the configured Sovereign, which is correct for all pre-family data).

Signet timeout: agree — make it configurable per assurance level with a hard cap; the trade (wider
approval-fatigue window) is honest and bounded by single-use txns.
