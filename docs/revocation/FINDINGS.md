# Durable Recognition Revocation — Findings

What Archon made easy or awkward, and an explicit **DEFERRED-SCOPE**. Grounded on real calls against a live
node (`flaxlap.local:4222`, `registry=local`); harnesses: `npm run smoke:revocation` (Task 1) and
`npm run e2e:revocation` (matrix).

## Verdict

Buildable on stock Archon, no blocker. Revocation is now durable (survives a fresh Warden), signed and
verifiable, version-pinned for after-the-fact audit, controller-enforced, and privacy-scoped — and it
fails closed everywhere the fact is unavailable. `MeshWarden.admit` uses a `RevocationResolver` in place of
the in-memory `Set` (which remains as a legacy fallback so the v1/depth-2 e2es are unchanged).

## Task 1 — the load-bearing assumption, grounded

All four confirmed on real calls (`smoke-revocation-api.ts`):

- **A Sovereign can create a signed asset whose body is a Hearthold structure.** `createAsset(addProof(list))`
  → the asset's `controller` is the Sovereign and the stored body verifies to the Sovereign DID.
- **It can be updated repeatedly, each update minting a new version.** Two `mergeData` updates took the list
  `versionSequence` 1 → 2 → 3, entries accumulating.
- **A resolver can pin a specific prior `versionSequence` and verify its `versionId`.** Resolving
  `{versionSequence: 2}` returned the historical list (only the first entry) with a `versionId` matching the
  one recorded at that time — the exact attenuation pinning discipline, reused.
- **Archon's controller model blocks a non-owner update.** A different identity's `mergeData` on the
  Sovereign's list was refused and the list was unchanged — this is what makes CONTROLLER-TAMPER structural,
  not a Hearthold check.

## What Archon made easy

- **Immutable audit history is free.** Because every `mergeData` mints a content-addressed `versionId` and
  old versions stay resolvable, "was this revoked at answer time?" needs no extra ledger — pin the version in
  the answer, resolve it later. `auditRevocationAt` is ~3 lines.
- **"Signed by the Sovereign" is both the body signature and the controller.** The list body carries an
  `addProof` (a holder can verify it), and the asset is controlled by the Sovereign (only it can update) —
  two independent guarantees from primitives already in use.
- **The same-node issuer/checker topology made this simpler than it looks.** No distribution, no gossip: the
  checker resolves the issuer's own asset. The resolver's max-age cache is a latency optimization, not a
  consistency mechanism.

## What Archon made awkward (and the workaround)

- **`mergeData` merges top-level keys — fine here, but a footgun.** Replacing the whole list works because we
  rewrite every top-level field (`issuer/listVersion/entries/updatedAt/proof`) each publish; a partial update
  would silently retain stale keys, and setting a key to `null` deletes it. We always write the full signed
  body.
- **Type friction at the `mergeData` boundary.** `addProof` returns a typed object; `mergeData` wants
  `Record<string, unknown>`, so the signed body is cast at that one call site. Cosmetic.
- **Fail-closed is a Hearthold decision, not an Archon default.** An unresolvable DID throws (`Invalid DID` /
  not-found); the resolver catches and returns `available:false`, and `admit` denies. Nothing in Archon makes
  "unavailable ⇒ deny" automatic — it is enforced in the checker, matching deny-by-default admission.

## DEFERRED-SCOPE — named, not built

- **Herd privacy for the list.** The published list is opaque per entry (only `recognitionId` UUIDs — no
  holder/Emissary DIDs, no domains; asserted in PRIVACY), **but its length still leaks HOW MANY recognitions
  an issuer has revoked** (activity volume). The standards-aligned upgrade is the **W3C Bitstring Status
  List**: the recognition carries an *index* into a fixed-size bitstring, so revocation is a bit flip and the
  published artifact reveals neither which nor how many are set. Same check, better privacy — noted, not built.
- **Cross-issuer revocation.** This checks a list you **own** (issuer == checker). Consulting a list published
  by a *different* Sovereign (whose recognitions you honor transitively) is a separate trust + freshness
  problem.
- **Revoking an attenuation/delegation chain.** This is **recognition** revocation only. Revoking a budget
  delegation (attenuation credential) mid-flight is a different mechanism.
- **Push / real-time revocation.** Polling with a max-age cache only; there is no notification channel, so a
  revocation is visible at most `maxRevocationAge` after publication (or immediately with `maxAgeMs: 0`, at
  the cost of a resolve per check). No push, no webhooks.

## Residuals / next steps

- **Bitstring Status List** is the clean successor for herd privacy and is W3C-aligned — the natural upgrade
  when revocation *volume* must be hidden, not just entry contents.
- **Tuning `maxRevocationAge`** trades latency-of-revocation against resolve load; `0` is strongest (always
  fresh), a few seconds is a reasonable default for a live mesh.
- **Cross-issuer + delegation-chain revocation** generalize the same asset+pin discipline to new trust edges.
