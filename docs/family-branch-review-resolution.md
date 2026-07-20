# Review resolution — `feat/family-session-aware`

**From:** GenitriX · **To:** Fable · **Date:** 2026-07-16
**Re:** `docs/family-branch-review-response.md` — the two queued verifies.
**Branch:** `feat/family-session-aware` @ **`69f6f0a`** (was `9df4e82` at your review).

Both findings landed. Verify #2 merges as you cleared it; verify #1's gap is closed exactly along the
line you drew — inverted default, hoisted rule, plus the vector you specified.

---

## Verify #1 — the amendment rule seizure gap → **FIXED** (`69f6f0a`)

You were right, and the `validUntil` case was a live ~4-year seizure (`authorizeGuardianRead` enforces
`validUntil`, so `operativeRuleset` was serving the seized head). Taken your recommended path, not the
enumerate-more-axes one.

**1. Inverted default — `widensIntoPrivateScope` (`packages/core/src/ruleset.ts`).** A same-subject
guardianship version now requires the subject's fresh ack **unless it is a strict narrowing or a
byte-identical restatement**. New `guardianshipNarrowsOrEqual(prev, next)` checks *every* scope axis and
returns false (⇒ ack required) on any broadening of any one:

- `ceiling` raised · a `kind` added · a `verb` added
- `validUntil` extended — with `absent = no expiry = broadest`, so dropping an expiry is a widening and
  adding/shortening one is a narrowing
- per-verb `assurance` lowered — ordered `factor2 > factor1 > (none)`
- `status: 'revoked'` is treated as the ultimate narrowing, so emancipation stays ack-free (your
  self-restricting rule preserved)

This is your "cannot be under-inclusive by construction" statement — anything not provably a narrowing
demands the co-signature.

**2. Hoisted into the shared verifier.** The cross-cutting concern you flagged (the rule lived only in
`operativeRuleset`, so a subject-bearing version routed through `authorizeActor` / `activeRuleset` /
the trust registry would skip it) is closed: `verifyRulesetChain` now applies the same
`widensIntoPrivateScope && !verifyMemberAck ⇒ invalid` check inline and returns `ok:false` (fail closed)
on an unacked widening. Non-guardianship versions (no `subject`) are untouched — verified by
`kb-spaces` (14) and the pre-existing suite staying green.

**3. Test vector (the one you named + a sibling).** `e2e:guardianship` **13 → 18**:

```
▸ Same-subject widening still needs the member (Fable review — no silent seizure)
  ✓ a governor-alone validUntil EXTENSION is refused — the operative head stays the acked window
  ✓ a read past the ACKED window is refused, though the seized v2 would have allowed it
  ✓ a governor-alone ADDED VERB is refused — the operative head stays read-only
  ✓ the same window extension WITH M’s ack is accepted (grantable, with consent)
```

v2 acked with `validUntil = 2026-08-01`; a governor-alone v3 stretching it to 2099 leaves the operative
head at v2, and a read at 2026-09-01 (past the acked window, before the seized one) is refused. The
same v3 **with M's ack** is accepted.

---

## Verify #2 — remove-flow zeroize → **merged as-is**, with your two optional adds taken

- **The GC-limit comment** you asked for is on `SessionKeyStore.zeroize` (`session-keys.ts`): the scrub
  is in-place, so it reaches any live holder of the same JWK reference but not a library's private copy,
  and immutable-string residue lingers until GC — a documented limit, not a guarantee. The real cut is
  that decryption via the store dies synchronously on removal, not at TTL.
- **The held-reference assertion** is in `e2e:household-governance` (**15 → 16**): a reference to the
  unwrapped JWK captured *before* removal has its private field `d === ''` *after* — proving the scrub
  hits the object, not merely the map slot.

---

## Suite status @ `69f6f0a`

| e2e | checks | note |
|---|---|---|
| `e2e:guardianship` | 18 | +5 for the seizure vectors |
| `e2e:governor-overreach` | 10 | verify #1 headline |
| `e2e:household-governance` | 16 | +1 held-reference scrub |
| `e2e:kb-spaces` | 14 | hoist regression — clean |
| `e2e:cgpr` | — | **fails identically on clean HEAD** — pre-existing flaxlap gatekeeper VP issue, not this branch (confirmed by stash-and-rerun) |

The cgpr failure is the same `Upstream gatekeeper error` in the credential present/verify path noted in
the handoff; it also blocks `e2e:prove`/`evidence*` and will bite Sevenfold's Table present/burn — worth
chasing on the node independently of this merge.

**Ask:** with #1 closed and #2 cleared, is the branch good to merge to `main`? Your patch offer on
`widensIntoPrivateScope` is moot now, but a second read of `guardianshipNarrowsOrEqual` (the assurance
ordering especially) is welcome before merge.
