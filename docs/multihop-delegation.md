# Multi-hop delegation — design + parity requirements (Phase 5, Part B)

**Status: the enforcement CORE is wired (2026-08-10).** The chain path now runs through the live reference
monitor with full single-hop parity + per-hop revocation, proven by an adversarial suite against a live node
(`e2e-multihop-confused-deputy`). What remains is the *daemon-facing* wiring (the `delegate-capability` verb +
pairwise hop transfer, and the Sovereign's watch/SSE dashboard) — additive plumbing on top of the now-proven
enforcement. This note keeps the original design + parity bar; the "Shipped" section at the end records what
landed and what's next.

## What it is

Today authority is single-hop: the **Sovereign** issues a scope capability VC to the **Emissary**, which
presents it (`verifyProof`, issuer = Sovereign). Multi-hop lets the **Emissary attenuate-and-hand-off** — issue
a *further-narrowed* child capability to a third party (a sub-agent, a booking service), who invokes it. The
chain is `Sovereign → Emissary → third party`, each hop monotonically narrower.

## Why it can't be plain VCs

A verifier cannot read an intermediate VC — VC1 (Sovereign→Emissary) is encrypted to the Emissary, so the
Warden can't decrypt it to check that VC2 (Emissary→third party) attenuates it. Verifying attenuation
therefore needs the **salted-commitment chain** (`attenuation.ts` / `capability-chain.ts`), where each hop's
`{authoritySet, salt, caveats}` is committed and **disclosed by the presenter** — the verifier checks the
chain without decrypting anyone's private VC. Two mechanisms coexist: VC challenge/response for single-hop,
the commitment chain for multi-hop.

## What's already built (and hardened)

`packages/core/src/capability-chain.ts` — unit-tested by `e2e-capability-chain` (8 assertions):

- `mintRootCapability` / `delegateCapability` — issue a root and attenuated children; `delegateCapability`
  refuses at issuance unless the child narrows authority **and** caveats (`capabilityNarrows`).
- `verifyCapabilityChain(leaf, { requireFullDisclosure: true })` — walks to the Sovereign root and enforces
  authority subset, lineage, counter, version-pinning, the signed subset assertion, the caveat-committing
  binding, **and** caveat narrowing across hops. Crucially it already carries the audit-2 fix: with
  `requireFullDisclosure` it **returns a bound leaf** (`holder`, `leafAuthoritySet`, `leafCaveats`) and the
  contract is *enforce those, not `credentialSubject`* — nothing is read from an unauthenticated wire body, and
  an omitted disclosure is refused.

So the hard chain-integrity work is done and tested in isolation.

## The parity bar — what wiring must add before it ships

The single-hop VC path earned its grade through audit-3/-4 hardening the chain path does **not** yet have.
Multi-hop must match it, or it becomes the weakest door:

1. **Warden-minted challenge (audit-3 §1).** A chain presentation must answer a fresh, single-use, Warden-minted
   challenge — otherwise a captured chain presentation is a permanent bearer token, exactly the hole the VC path
   closed. The chain has no challenge analog today.
2. **Holder proof, not just transport.** The VC path binds the caller to the credential subject via
   challenge/response (`responder === subject`) *and* authcrypt `fromDid`. The chain path returns
   `leaf.holder`; binding it only by authcrypt `fromDid` is transport-level (repudiable). Add a
   challenge/response proof of control over `leaf.holder` for parity.
3. **Revocation per hop.** Confirm `verifyAttenuationChain` checks each hop's status (fail-closed), and that a
   revoked *intermediate* hop kills the chain — not just the leaf. Revocation-by-default (audit-4 §4) must hold
   at every hop.
4. **Human-gate policy (audit-4 §3).** The disclosed sensitivity crosses the same `requiresHumanAt` step-up +
   discharge-digest binding as single-hop.
5. **Caveat-shape validation (audit-4 §2).** The bound leaf's `ceiling`/`resources`/etc. are validated as
   shapes at the boundary — Archon does not enforce schema shape (`reference-archon-schema-not-enforced`).

## The adversarial test bar

A `e2e-multihop-confused-deputy` red test, mirroring `e2e-invocation-confused-deputy`, must refuse: a forged
leaf, an omitted hop disclosure, an **over-attenuation** (child widening a parent's authority or caveats),
a captured chain presentation replayed by a non-holder, a replay against a stale/absent Warden challenge, a
revoked intermediate hop, and a foreign-owner leaf. Plus a dispatcher-level test over real DIDComm.

## Recommendation

Treat this as its own workstream with a red-team pass (audit-5 scope), not a wrap-up commit. The machinery is
ready; the **integration** is where audits 2–3 found their defects, so it earns the same rigor: wire the chain
path, add the five parity items, write the adversarial suite, then have it independently audited before it
authorizes a real disclosure.

The Emissary-side gesture, when built: an `emissary delegate-capability <holderDid> [narrower caveats]` verb
over `delegateCapability` (which already refuses a non-attenuating child at issuance).

## Shipped — Phase 5B enforcement core (2026-08-10)

The chain path is wired into the live monitor and passes an adversarial suite against a live node. Each parity
item above is now met and located:

1. **Warden-minted challenge** ✅ — a chain presentation carries a `SignedHolderProof` over a fresh, single-use
   `ChallengeStore` challenge, gated by `requireChallenge` (`resolveChainInvocation`, `invocation-monitor.ts`).
2. **Holder proof, not just transport** ✅ — the leaf holder SIGNS the proof; the monitor checks the signer ==
   the chain-attested `holder` (from `verifyCapabilityChain`), not just authcrypt `fromDid`.
3. **Revocation per hop** ✅ — `verifyAttenuationChain` now runs an injected `checkHopStatus` for **every**
   disclosed hop, fail-closed (`(revoked)`/`(status)`/`(revocable)`). Revoking an ancestor kills the subtree at
   the next invocation. Each hop's status resolves against **that hop's controller** (the delegator revokes what
   it issued). *This is the Sovereign's kill-switch.*
4. **Human-gate policy** ✅ — the chain builds the same `VerifiedLeaf` the single-hop path does, so
   `authorizeInvocation` applies `requiresHumanAt` + the discharge-digest binding identically (parity by
   construction, not duplication). Same for expiry, `singleUse`, replay burn, and ceiling.
5. **Caveat-shape validation** ✅ — `resolveChainInvocation` validates the commitment-bound leaf caveats
   (numeric ceiling, …) at the boundary before enforcement (Archon does not enforce schema shape).

**Adversarial gate:** `e2e-multihop-confused-deputy` (live) — GRANTS the happy chain and REFUSES replay, a
foreign-holder proof, a stale challenge, an omitted hop, over-attenuation, and a **revoked intermediate**.

**Still to wire (daemon-facing, additive — rides on the proven core):**
- `emissary delegate-capability` verb + persisting held `CapabilityHandle`s + accumulating ancestor disclosures
  + pairwise hop transfer to the delegate. A dispatcher-level test over real DIDComm.
- The Sovereign's **watch backend** (lineage in `CapabilityGrantStore`, SSE flow events, `GET /api/capabilities`
  lineage, A2A envelope-only flow events) — monitoring, not enforcement.

**Revocation semantics to remember:** you can revoke what you *issued* — the Sovereign revokes hops in its
lineage (root → Emissary), each delegator revokes its own children; revoking any ancestor cuts everything below
it. There is no "revoke a hop someone else issued" — cut the ancestor instead.
