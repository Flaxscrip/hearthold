# Review handoff — `feat/family-session-aware` → Fable

**Branch:** `feat/family-session-aware` @ `9df4e82` (pushed to `Flaxscrip/hearthold`)
**From:** GenitriX · **To:** Fable · **Date:** 2026-07-16
**Base:** branches from `origin/main`; 11 commits ahead, no merge conflicts expected.

The multi-Sovereign **family model** (plan: `docs/plan-under-review.md`) is complete through **Phase 5
(guardianship)**. Everything below is green against the live Archon node (`flaxlap.local`) on
`HEARTHOLD_REGISTRY=local`. This note hands you the **two verifies you queued** against the branch,
plus the run harness and context.

---

## The two queued verifies (your asks)

### 1. Amendment rule — `734d8ff` (`family(phase 4): the amendment rule`)

**The claim to break:** an access-widening Ruleset transition is invalid unless the affected member's
own signature is in it; the Warden **fails closed to the prior version**, never the widened one.

- **Core:** `packages/core/src/ruleset.ts` — `widensIntoPrivateScope(prev, next)`,
  `signMemberAck` / `verifyMemberAck`, `operativeRuleset()` (walks the chain, breaks on an
  unacknowledged widening or a broken link, serves the last valid active head). `verifyRuleset` now
  verifies the **governor proof over the _base_ ruleset** (excludes `memberAck`, which is a second
  signature over the same base) — confirmed backward-compatible with plain 2-version chains.
- **e2e:** `npm run e2e:governor-overreach` — **9 checks**. Headline vectors: a governor-signed v2
  widening into member M's private scope **without M's ack → rejected, Warden serves v1**; the **same
  transition with M's ack → accepted**; a forged history → **hash-linkage fails** against M's pinned
  copy; an over-ceiling / out-of-kind reach → refused.
- **What to hammer:** the precision of `widensIntoPrivateScope` (new subject, raised ceiling, added
  kinds each count as widening; narrowing / re-stating / non-guardianship changes do not) and that
  `operativeRuleset` truly fails **closed to prior** rather than dropping the whole chain.

### 2. Remove-flow zeroize — `3c188ee` (`family(phase 4): admit/remove flows + zeroize-on-removal`)

**The claim to break (your watch-item #1):** a removed member's **already-unwrapped** read-guest key
dies **on removal, immediately — not at TTL**.

- **Core:** `packages/warden/src/household.ts` — `removeMember()` calls
  `sessions.revokeAllFor(memberDid)` → `sessionKeys.zeroize(token)` for each returned token, in the
  same operation as `removeVaultMember` + roster revoke.
- **e2e:** `npm run e2e:household-governance` — **15 checks**, tested against a **partition-sealed
  note** (the exact case you named): admit grants shared read + a member-key partition; a live session
  transiently RAGs the member's content; **remove** revokes the session AND zeroizes the unwrapped key
  at the same instant → the Warden can **no longer decrypt** the member's partition note. Also covers
  share-to-household owner-only + contributor-tier + non-owner refusal.
- **What to hammer:** that the zeroize is synchronous with removal (no TTL window), that
  `SessionKeyStore.zeroize` actually clears the key material (not just the map entry), and the
  cross-member isolation around it.

---

## Run harness

Node ≥ 22. Live Archon node required (Drawbridge on `:4222`). Each script builds first, runs in an
isolated data root, and asserts. Registry hygiene: **`local`** everywhere.

```bash
cd ~/hearthold
export HEARTHOLD_NODE_URL=http://flaxlap.local:4222
export HEARTHOLD_REGISTRY=local
export HEARTHOLD_CLASSIFIER=quarantine     # no Ollama dependency
export HEARTHOLD_INDEX=off
export HEARTHOLD_DATA_ROOT="$(mktemp -d)"  # never touch a real ~/.hearthold
export HEARTHOLD_PASSPHRASE=review-pass     # separate wallets; any dev value

npm run build
npm run e2e:governor-overreach     # verify #1  (9 checks)
npm run e2e:household-governance   # verify #2  (15 checks)
```

### Full green suite on this branch (for context)

| e2e | checks | covers |
|---|---|---|
| `e2e:governor-overreach` | 9 | **verify #1** — amendment rule, fail-closed-to-prior |
| `e2e:household-governance` | 15 | **verify #2** — admit/remove/share, zeroize-on-removal |
| `e2e:guardianship` | 13 | Phase 5 — grantable/scoped/receipted/conspicuous/expiring + store surface |
| `e2e:partition-rewrap` | 12 | Phase 2 — ephemeral rewrap, read-guest, zeroize on session end |
| `e2e:family-isolation` | 9 | Phase 3 — per-member visible sets, no cross-member leak |
| `e2e:kb-spaces` | 14 | regression — KB spaces unaffected |

---

## Branch commits (oldest → newest)

```
0473697 family(phase 0): additive types + configurable step-up timeout
96e23e2 family(phase 1): member-key private partitions, vault ownership, shared Vault
9bc2f45 docs(family): design record — plan, guardianship threat model, rewrap spec
1530124 family(phase 2a): control-plane sessions + per-member Signet + timeout
84be943 family(phase 2b): partition-key rewrap handshake (the read-guest half)
9eae87b family(phase 3): per-member scoping, card/face fix, SSE audience filter
734d8ff family(phase 4): the amendment rule            ← VERIFY #1
3c188ee family(phase 4): admit/remove + zeroize        ← VERIFY #2
dc149ee family(phase 4): wire the governance surface — routes, share, household-init
d19a1f3 family(phase 5): guardianship core
9df4e82 family(phase 5): wire the guardianship surface
```

Design record for the review: `docs/plan-under-review.md`, `docs/guardianship-threat-model.md`,
`docs/phase2-rewrap-handshake-spec.md`.

---

## Caveats to flag before merge

- **Pre-existing / environmental (NOT this branch):** `e2e:prove` / `e2e:evidence*` fail with
  `{"error":"Upstream gatekeeper error"}` in the credential-VP flow (`requestProof`/`presentProof`/
  `verifyProof`) on `flaxlap` — reproduces on unchanged tests and both registries. Our session logins
  use pure-auth challenges, which work. Called out because it will also bite Sevenfold's Table
  present/burn; worth a look independently of this review.
- **Working-tree hygiene:** `~/hearthold` has untracked brief/dataflow cruft from the Sevenfold
  overlap. All Phase 3–5 commits staged files **explicitly** (never `git add -A`), so none of it is on
  the branch. `git log --stat` is clean.
- **Not yet built (Phase 6, out of scope for this review):** contributor-tier surfaced in
  `KbView`/console, and the Table-side conspicuous "padlock" UI — a Sevenfold front-end concern; the
  data surface it needs is live at `GET /api/guardianships`. Remote private-partition federation stays
  parked at the `PartitionLocation:'remote'` seam.
