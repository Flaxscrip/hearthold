# Review response — `feat/family-session-aware` @ `9df4e82`

**From:** Fable · **To:** GenitriX / the Hearthold dev · **Date:** 2026-07-16
**Re:** `docs/family-branch-review-handoff.md` — the two queued verifies.
**Method:** static review of the code + the e2e scripts. The Archon node (`flaxlap.local`) is not reachable from my
environment, so I did **not** run the live suite — I read `packages/core/src/ruleset.ts`,
`packages/warden/src/household.ts`, `session-keys.ts`, `control-session.ts`, and the two e2e scripts and
tried to break the claims by construction. That lens matters here: the suite is green, but green does
not cover the gap below — precisely because the gap is untested.

---

## Verdict

| Verify | Result | Action |
|---|---|---|
| **#2 — remove-flow zeroize** (`3c188ee`) | **Passes.** Decryption dies synchronously with removal. | Merge as-is. |
| **#1 — amendment rule** (`734d8ff`) | **Mechanism correct; `widensIntoPrivateScope` is under-inclusive.** One miss is a directly-exploitable seizure. | One-function fix + one test before guardianship is relied on. |

---

## Verify #1 — the amendment rule

### What is solid (I tried to break each)

- **Member acks are version-bound.** `signMemberAck` signs `baseRuleset(...)`, which includes `version`
  and `previous`. So a governor cannot lift M's ack off v2 and re-attach it to v3 — the base differs and
  `verifyMemberAck` recomputes over v3's base and fails. Replay is closed.
- **`operativeRuleset` truly fails closed to the prior head** on: an unacked widening, a broken `previous`
  link, a mid-chain signer change, non-contiguous versions, or an unsigned/tampered version. It serves the
  last valid `active` version, never the widened one.
- **Governor pinning holds** (`expectedSigner`), and a **non-subject's signature does not satisfy the ack**
  (`verifyMemberAck` checks `signer === signed.subject`).
- The e2e asserts all of the above non-tautologically. Good code — this is the right shape.

### The gap: `widensIntoPrivateScope` misses three widening axes

The predicate tests only **new subject**, **raised ceiling**, and **added kinds**. It ignores
**`validUntil`, added verbs, and lowered per-verb assurance**. The `validUntil` miss is a concrete
seizure of the surveillance window:

1. **v2** — guardianship over member M, `kinds:['location']`, ceiling `MEDIUM`, `validUntil:'2026-08-01'`.
   **M acks it.** M consents to being watched *until August 1*.
2. **v3** — the governor signs *alone*, everything identical **except `validUntil:'2030-01-01'`**. Same
   subject, same ceiling, no new kinds → `widensIntoPrivateScope(v2, v3)` returns **false** → no ack
   required → `operativeRuleset` accepts v3 as the operative head.
3. `authorizeGuardianRead` **enforces `validUntil`** (ruleset.ts:277). So guardian reads that should be
   expired now succeed **for ~4 years the member never consented to.**

That is exactly the "seizable" property the threat model promises against, along the temporal axis.
**Added verbs** (e.g. slipping in `write`) and **lowered assurance** are the same class: inert in today's
`authorizeGuardianRead` (it checks neither), but they *are* the guardianship's declared scope, and
`authorizeActor` **does** enforce verbs — so they are a latent widening waiting for a consumer.

### Recommended fix — invert the default, don't enumerate more axes

Enumeration is what just failed (it missed three axes). Prefer the conservative rule:

> **A guardianship version (`subject` set) requires the subject's fresh `memberAck` unless it is a strict
> narrowing or a byte-identical restatement of the prior guardianship.**

Acks are cheap and already version-bound, so "the member co-signs every expansion of their own watch" is
the clean statement of *grantable but never seizable*, and it **cannot be under-inclusive by
construction.** If you'd rather keep the narrowing-allowed optimization, the minimal patch is to also flag
a `validUntil` extension, any added verb, and any assurance downgrade — but that reintroduces the
enumeration fragility (and needs a tier ordering for assurance), so the inverted default is the safer
choice.

### Cross-cutting: the rule lives in only one consumer

The amendment rule is applied **only** in `operativeRuleset`. `verifyRulesetChain` / `activeRuleset` /
`authorizeActor` never call `widensIntoPrivateScope`. Given "one Ruleset chain per actor," a governor's
single chain can carry both governance and guardianship (subject-bearing) versions — and anything that
evaluates that chain through `authorizeActor` skips the ack check entirely, accepting an unacked widening
head that `operativeRuleset` would reject. Either **enforce** that subject-bearing chains only ever go
through `operativeRuleset` / `authorizeGuardianRead`, or **hoist** the amendment rule into the shared
verifier so it cannot be routed around.

### Test coverage note

The 9 checks in `e2e-governor-overreach` exercise the **new-subject** widening and a shared-policy
non-widening — they do **not** exercise a **same-subject** delta (temporal / verb / assurance). Add at
least one vector: v2 acked with a `validUntil`, then a governor-alone v3 that only extends `validUntil`,
asserting the head stays at **v2** (fail closed).

---

## Verify #2 — remove-flow zeroize

**Passes.** Walking it adversarially:

- `removeMember` revokes membership **first** (`vault.remove` + `revokeAuthorization` on read/write
  groups), **then** `revokeAllFor(memberDid)`, **then** `zeroize` on each returned token. Ordering is
  right: membership is gone before the key dies, so a concurrent rewrap would already fail on membership.
- `revokeAllFor` iterates all sessions and deletes matches — **Map deletion-during-iteration is
  well-defined in JS**, so every one of the member's live tokens is captured, including not-yet-GC'd
  expired ones.
- `zeroize` overwrites the JWK's own fields **in place** (`rec[k] = ''`) before `m.clear()` +
  `keys.delete(token)`. Because it mutates the object in place, it scrubs **any holder of that same
  reference**, not just the map slot. Synchronous with removal — no TTL wait.
- The e2e proves the operative property: the exact `openWithKey` path that decrypted Alice's
  partition-sealed note *before* removal can **no longer** decrypt *after*.

**Caveat (a known limit, not a break):** the in-place scrub reaches the *original* JWK object, but cannot
reach a *copy* a crypto library may have made, and JS's immutable strings mean the original secret string
lingers until GC. That is the ceiling for in-memory secrets in a GC'd runtime — fine to ship; worth one
code comment so a future reader doesn't mistake it for a guarantee. Also, the e2e only proves the
**map-clear** (it doesn't retain a pre-removal reference and assert the JWK's `d` went empty), so if you
want the scrub itself covered, one extra assertion on a held reference would do it. Optional.

---

## Bottom line

- **Verify #2 merges as-is.**
- **Verify #1:** the machinery is right and well-tested; the single change I'd gate merge on is making a
  `validUntil` extension (and, by the inverted-default rule, any non-narrowing guardianship delta) require
  the member's ack, plus one e2e vector for it. **One function, one test — not a redesign.**

Happy to draft the `widensIntoPrivateScope` patch and the missing test vector on request.
