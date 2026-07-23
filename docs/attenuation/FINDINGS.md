# Verifier-Enforced Attenuation — Findings

What worked, what Archon made awkward, and where the model needed a workaround. Everything below is
grounded in **real API calls** against a live node (`@didcid/keymaster` 0.6.0 → `flaxlap.local:4222`,
`registry=local`), not documentation. The grounding harness is
[`scripts/smoke-attenuation-api.ts`](../../scripts/smoke-attenuation-api.ts) (`npm run smoke:attenuation`).

## Verdict

This is **verifier-enforced attenuation**: the verifier walks the chain and checks the subset relation at
each hop. It is the middle of three tiers — stronger than *issuer-convention attenuation* (non-expansion by
convention only, which we rejected as unenforceable), and weaker than *cryptographically-constrained
attenuation* (over-expansion made unrepresentable, macaroon/capability-style — deferred, see Residuals).

The model is **buildable and works as specified** on stock Archon. No blocker. The verifier ACCEPTs a valid
chain and REJECTs all six violation classes with the intended reasons (see
[ATTENUATION-TEST-RESULTS.md](./ATTENUATION-TEST-RESULTS.md)). Archon stayed dumb throughout — it stored
cleartext, encrypted pairwise, versioned, and resolved; **all authority/subset/lineage semantics live in
Hearthold**, and the **verifier is the only enforcement point** (issuance-time subset refusal is a courtesy,
not relied on).

---

## The two explicit questions

### 1. Is resolve-by-versionId exposed? — **YES** (by `versionSequence`, with `versionId` as the integrity check)

`ResolveDIDOptions` (`@didcid/gatekeeper/types`) exposes **`versionSequence?: number`** and
**`versionTime?: string`**. The keymaster method is `resolveDID(did, { versionSequence })`; the MCP tool
`archon_resolve_did_version` maps to exactly this. Grounded live:

```
mergeData(vc, {pic:'first'})   → seq 2, versionId A
mergeData(vc, {pic:'WIDENED'}) → seq 3, versionId B
resolveDID(vc, {versionSequence: 2}) → returned the seq-2 doc: versionId === A, pic === 'first'  ✓
resolveDID(vc)                        → returned the LATEST:     versionId === B, pic === 'WIDENED'
```

**Nuance that matters for the model:** you pin and resolve by the integer **`versionSequence`**, *not* by the
content-addressed **`versionId`** string — `versionId` is not itself a resolution key. So a `PrevPin` records
**both**: it resolves by `versionSequence`, then **asserts the returned doc's `versionId` equals the pinned
`versionId`**. That check is what makes pinning tamper-evident: because each version is content-addressed and
history is append-only (old `versionId`s persist and stay resolvable), a parent cannot alter the content at a
past sequence — it can only append a new one, which a pinned child never follows. This is the load-bearing
property behind the PREV-TAMPER result.

### 2. Does challenge/response disclose SELECTED payload fields (authoritySet+salt), or the whole credential? — **Neither, natively; we disclose by encryption scope**

Archon's challenge/response is **credential-granular**, confirmed from the types:
`Challenge.credentials[] = { schema, issuers? }` — a challenge requests **issued credentials by schema +
issuer**, and `createResponse(challengeDID)` returns verifiable **presentations** (`{ vc, vp }`) of matching
credentials the responder *holds as subject*. It can redact fields *within an issued VC* (VP-level selective
disclosure), but it does **not** "reveal field X of an arbitrary pairwise-encrypted Asset payload."

Our `authoritySet+salt` is a **pairwise-encrypted asset field** (`cipher_sender/cipher_receiver`), not a
subject-bound issued VC — so the keymaster ceremony is not the disclosure path here, and it doesn't need to
be. **Selective disclosure is achieved by encryption scope:** the set is its own encrypted field, the holder
(the pairwise recipient) reveals *exactly* it via `decryptJSON`, and the **salted commitment binds the
reveal** so the holder cannot lie about the set. Grounded live (DISCLOSURE row): the holder decrypted C1's
payload to `{read on X}` and the recomputed commitment matched the cleartext `authorityCommitment`.

> If a deployment wanted the *formal* challenge/response ceremony, each hop's `authoritySet` could instead be
> **issued as a standalone bound VC** (its own schema) to the holder and disclosed as a VP. That's heavier
> (an extra credential + subject binding per hop) and buys nothing over the commitment-bound decrypt for this
> model — but it is available on stock Archon.

---

## What worked cleanly

- **Cleartext + ciphertext in one asset.** `encryptJSON(payload, holder)` mints the VC (its `didDocumentData`
  = `{ cipher_hash, cipher_sender, cipher_receiver }`), then `mergeData(vc, { pic })` writes the cleartext
  `pic` beside the cipher. Final `didDocumentData` = `{ pic, cipher_* }`. Exactly the confirmed live-doc shape.
- **`setProperty` = `mergeData`.** Archon has no `setProperty` method; the MCP tool `archon_set_property`
  wraps `keymaster.mergeData(id, { key: value })`, which merges into `didDocumentData` and produces a new
  content-addressed version (`versionId`) with an incremented `versionSequence`. Mutable but tamper-**evident**.
- **Controller = the Agent DID.** A `createAsset`/`encryptJSON` asset is controlled by the current wallet ID
  (the attenuating Agent DID). The verifier reads `didDocument.controller` and requires the attenuation
  assertion to be signed by it — no extra binding needed.
- **Signatures via `addProof`/`verifyProof`.** `addProof(obj, controllerName)` embeds a `proof` whose
  `verificationMethod` names the signing DID; `verifyProof(obj)` validates it. This gives an **independently
  forgeable** assertion (sign with any DID) whose signer the verifier extracts and checks against the
  controller — precisely what the FORGED-ASSERTION test needs.
- **Third-party posture is real.** The verifier ran on a **separate node handle** using only `resolveDID`
  (public) + `verifyProof` — no wallet secrets, no decryption on the structural path. Point it at any
  Gatekeeper (own node = sovereign; SaaS = provider); trust equals Archon resolution trust, nothing more.

## What Archon made awkward (and the workarounds)

- **`versionId` is not a resolution key.** You cannot `resolveDID(did, { versionId })`; you pin by
  `versionSequence` and verify `versionId` on the returned doc. Workaround: `PrevPin` carries both. Minor, but
  a caller who stored only the `versionId` string could not re-fetch that version directly.
- **`mergeData` is merge-with-delete semantics.** Setting a key to `null` **deletes** it
  (`updatedData[key] === null → delete`). Harmless here (we always write a full `pic`), but a naive
  "set this sub-field to null" would silently drop the field rather than store a null.
- **Two versions minimum per hop.** Because `encryptJSON` *creates* the asset (v1 = cipher) and the pic is a
  *second* update (v2 = cipher + pic), the pin a child embeds is **v2**, not v1. Not a problem — just note the
  pinned sequence is the pic-bearing version, and the smoke/e2e capture it after the `mergeData`.
- **`addProof` uses `confirm: true` internally.** It resolves the signer with `{ confirm: true }`, so the
  signing DID must be **confirmed** on the registry. On `local` that's immediate; on a slower/anchored
  registry there could be a confirmation lag between `createId` and first `addProof`.
- **Assets are permanent.** Every run mints a fresh lineage on the node (no teardown). Fine for `local`;
  something to weigh before pointing the matrix at a shared/public registry.

## Security notes (grounded, not assumed)

- **Salt is load-bearing.** Over a 64-element authority-set candidate space, **unsalted** enumeration
  recovered the preimage in 1 hit; **salted** (256-bit) recovered **0**. A naive unsalted commitment is
  trivially reversible for small capability vocabularies — the salt is not optional.
- **Structure proves integrity, not subset.** A hiding commitment means the structural verifier proves chain
  integrity (pinning, counter, commitment consistency, signatures) but **cannot decide `⊆`** — an over-broad
  child with a well-formed chain is structurally valid. `⊆` is enforceable only **on disclosure**, where the
  commitment binds the revealed set. This is inherent to hiding, documented as the model's honest core
  finding — not a verifier bug. A deployment that must enforce `⊆` **without** disclosure would need a ZK
  subset/range proof (out of scope here).
- **Two independent defenses for the two attenuation attacks.** An *honest-commit* over-broad child is caught
  by the disclosed `⊆` check; a *forged* `parentAuthorityCommitment` is caught by the commitment-chain check
  (d) — a fabricated parent commitment never equals the parent's own committed value.
- **Cross-lineage is over-determined (good).** A spliced successor trips **lineage**, and would independently
  trip **(d)** and the **pin** — belt and suspenders.

## Residuals / next steps

- **Per-resource operations.** `AuthoritySet` is a flat `{operations, resources}` pair; `isSubset` requires
  subset in both dimensions. A richer capability (operations scoped *per* resource) would refine `isSubset`
  and the disclosed check without touching the chain machinery.
- **Revocation** is orthogonal and unaddressed here — a hop's Asset DID could be revoked
  (`revoke_did`) and the verifier taught to reject a revoked hop.
- **Formal disclosure ceremony.** If a relying party requires the keymaster challenge/response VP flow rather
  than a commitment-bound decrypt, issue each hop's `authoritySet` as a bound VC (see Q2). Prototype uses the
  lighter, sufficient encryption-scope disclosure.
- **ZK subset proof** would let the verifier enforce `⊆` with zero disclosure — the natural follow-on if
  authority sets must stay private end-to-end.
- **Cryptographically-constrained attenuation** (macaroon / capability-style) is the deferred stronger tier:
  each hop's key is derived so that over-expansion is *unrepresentable* rather than caught by a verifier
  walk. It removes the "verifier is the only enforcement point" caveat, at the cost of a different key model.
