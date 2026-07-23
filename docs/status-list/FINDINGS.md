# Bitstring Status List Revocation — Findings

What Archon made easy or awkward, the honest limits of herd privacy, and an explicit **DEFERRED-SCOPE**.
Grounded on real calls against a live node (`flaxlap.local:4222`, `registry=local`); harnesses:
`npm run smoke:status-list` (Task 1) and `npm run e2e:status-list` (matrix).

## Verdict

Buildable on stock Archon, no blocker. Revocation is now a fixed-size **W3C Bitstring Status List** —
durable, signed, version-pinned for audit, controller-enforced, random-indexed, and fail-closed. The
recognitionId list is **deleted, not kept alongside** (no dual path — the mistake just removed with the
in-memory Set). We credit the **W3C Bitstring Status List** specification the way the disclosure work credits
RFC 9901: we adopt its shape (fixed-length GZIP+base64 bitstring, `statusListIndex`, `statusPurpose`).

## Task 1 — the load-bearing assumption, grounded

The new concern over the old recognitionId list was payload SIZE. Confirmed live: a ~50%-dense bitstring —
the worst case for GZIP, near-incompressible — is a **21.4 KB** base64 payload (~16 KB compressed). Archon's
`createAsset` stored it, repeated `mergeData` updates minted clean versions (seq 1 → 2 → 3), and
`resolveDID({versionSequence})` returned the pinned historical bitstring with a matching `versionId`. A
non-Sovereign `mergeData` was refused by the controller model. No size blocker.

## What Archon made easy

- **The whole mechanism is `createAsset` + `mergeData` + versioned resolve.** The bitstring is just an
  opaque signed blob; setting a bit is decode → flip → re-encode → `mergeData`. Version history and the
  controller check come for free, exactly as with the prior list.
- **Version pinning carries over unchanged.** The answer pins `{versionSequence, versionId}`; `auditAt`
  resolves that version and reads the bit. Same discipline as attenuation and the old revocation list.
- **`admit` barely changed.** The check went from "is `recognitionId` in the list" to "is the bit at
  `statusListIndex` set", plus a guard that the recognition points at the list this node checks. Fail-closed
  semantics and the max-age cache are identical.

## What Archon made awkward (and the workaround)

- **`mergeData` merges top-level keys.** We rewrite the full signed body (`issuer/statusPurpose/encodedList/
  listVersion/updatedAt/proof`) each publish, so the merge is a replacement; a partial update would retain a
  stale `encodedList`. Same footgun as before, same discipline.
- **base64 inflates the payload ~33%.** The W3C `encodedList` is GZIP **then** base64; the ~16 KB compressed
  worst case becomes ~21 KB on the wire. Well within Archon's asset limits, but noted.

## The collision bound that motivated durable allocation (on the record, not quietly fixed)

The first cut assigned indices randomly with **no persistent record** of what had been allocated — an
in-process `Set` at best. That is a **correctness bound**, not a privacy nicety: random assignment over
131,072 slots hits birthday collisions sooner than intuition suggests — **~14% odds of at least one
collision by 200 issued recognitions, roughly even by ~400.** A collision is not cosmetic: two recognitions
share a bit, so **revoking one silently revokes the other**, or a newly issued recognition is **born revoked**
because its slot was already set. Neither failure is visible at issuance.

The fix (see [`packages/core/src/allocation.ts`](../../packages/core/src/allocation.ts), `npm run
e2e:allocation`): the issuing Sovereign keeps a durable **AllocationRecord** (recognitionId → index) as a
second Archon asset it OWNS and **seals to itself** (`sealForWarden` to its own DID). Allocation reads the
record, picks a random **free** index, writes it back, returns it — collision-free by construction. This
costs **nothing** in herd privacy: herd privacy is about what a verifier learns from the public list; the
issuer already knows who it issued to, so recording that in its own sealed vault reveals nothing new to
anyone. Concurrency is optimistic + **version-pinned**: read at version N, re-check the head is still N
before writing, retry on conflict; a post-write verify is the backstop. Exhaustion is a **clear error**,
never a silent reuse (rolling to a fresh list is deferred). `publishRevocation` now takes a `recognitionId`
and resolves the index through the record — the caller tracks nothing. All grounded live (NO-COLLISION over
a constrained space where random ~certainly collides; RESTART-SAFETY across a fresh issuer; CONCURRENCY with
a forced version conflict; SEALED against a third party; EXHAUSTION).

## IMPORTANT — herd privacy REDUCES but does NOT ELIMINATE volume leakage

State this plainly. The fixed 131,072-bit **length** no longer encodes the revocation count the way a UUID
list's length did — that leak is closed. **But the compressed SIZE still leaks loosely.** A GZIP'd bitstring
with many set bits compresses worse than a sparse one: an all-zeros list is a few dozen bytes, a ~50%-dense
list is ~16 KB. So an observer who fetches the list learns an *approximate* revocation density from its
compressed size — fuzzy (not an exact count, not identities, not order), and far better than a list whose
length **is** the count, but **not zero**. Herd privacy here is a reduction, not an elimination; do not read
it as perfect. (Eliminating it would need padding the compressed form to a constant size, or a scheme that
doesn't ship the raw bitstring — out of scope.)

## Scoping — what herd privacy protects, and what it does not

Herd privacy protects against the **issuer** (or the list host) learning **which credential a verifier is
checking**: the verifier fetches the *whole* list and reads one bit locally, so no per-credential query is
observable. It does **not** hide a credential's status from a **verifier who already holds the credential**:
that verifier knows the credential's `statusListIndex` and can fetch the list repeatedly to watch that one
bit over time. That is **inherent to the W3C Bitstring Status List design**, not a defect of this
implementation — the status of a credential you hold is meant to be checkable — but it should be stated, not
assumed. (It also implies the disclosed `statusListIndex` is visible to the checker; that is fine here, where
the checker is the recognizer.)

## DEFERRED-SCOPE — named, not built

- **Constant-size encoding.** Padding the compressed `encodedList` to a fixed size (or encrypting it) would
  close the residual size-correlation leak above. Not done — the W3C form ships the GZIP'd bitstring as-is.
- **Status-list rollover on exhaustion.** When a list's 131,072 slots are all allocated, allocation errors
  cleanly (no reuse). Rolling to a *fresh* status list (a new asset + migrating the pointer) is not built.
- **Cross-issuer status lists.** This checks a list you **own** (issuer == checker). Consulting a list
  published by a different Sovereign is a separate trust + freshness problem.
- **Revoking an attenuation/delegation chain.** Status lists here cover **recognition** revocation only; a
  budget delegation is a different mechanism.
- **`suspension` and other status purposes.** Only `statusPurpose: 'revocation'` is implemented; the W3C
  spec also defines suspension (reversible). Not built.
- **Push / real-time.** Polling with a max-age cache only; a revocation is visible at most
  `maxRevocationAge` after publication (or immediately with `maxAgeMs: 0`, at a resolve per check).

## Residuals / next steps

- **Constant-size `encodedList`** is the clean successor for closing the compressed-size correlation.
- **Status-list rollover** (fresh list on exhaustion) generalizes the allocation record to multiple lists.
- **Suspension + cross-issuer** generalize the same asset + pin discipline to new status purposes and trust
  edges.
