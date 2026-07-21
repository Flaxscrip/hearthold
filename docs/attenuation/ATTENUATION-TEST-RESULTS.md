# Attenuation-VC ("Pattern 2") — Test Results

Working prototype of chain-attenuation for `did:cid` verifiable credentials, run **live** against an
Archon Keymaster/Gatekeeper (`@didcid/keymaster` 0.6.0 → Drawbridge on `flaxlap.local:4222`,
`registry=local`). The deliverable is the **verifier correctly rejecting** the violations it is designed to
catch. A `REJECT` with the right reason is a PASS; the verifier was never loosened to green a rejection.

- Core model + verifier: [`packages/core/src/attenuation.ts`](../../packages/core/src/attenuation.ts)
- Capability smoke (grounds every Archon call): [`scripts/smoke-attenuation-api.ts`](../../scripts/smoke-attenuation-api.ts)
- Test matrix: [`scripts/e2e-attenuation.ts`](../../scripts/e2e-attenuation.ts)

**One-command entry points**
```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass' HEARTHOLD_REGISTRY=local \
       HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222
npm run smoke:attenuation   # prove the Archon primitives (blocker check)
npm run e2e:attenuation      # the full REJECT/ACCEPT matrix
```

---

## The model, in one screen

Each VC hop is **its own Asset DID**, controlled by an **Agent DID** (the attenuating actor — the Warden).
Two layers live in the asset:

| Layer | Written with | Visibility |
|---|---|---|
| `authoritySet` + `salt` (the real capability) | `encryptJSON(payload, holder)` → `cipher_sender/cipher_receiver` | pairwise-encrypted; disclosed only on holder decrypt |
| cleartext **`pic`** block (lineage, counter, pinned parent, commitments, signed assertion) | `mergeData(vcDid, { pic })` — Archon's `setProperty` | public; resolvable by anyone, **zero decryption** |

Both coexist in **one** asset document — confirmed on a live doc: `didDocumentData` held
`{ pic, cipher_hash, cipher_sender, cipher_receiver }` together.

### Schema (`packages/core/src/attenuation.ts`)

```ts
interface AuthoritySet { operations: string[]; resources: string[]; }        // encrypted
interface AuthoritySetPayload { authoritySet: AuthoritySet; salt: string; }   // encrypted (salt = 32 bytes hex)

interface PrevPin {            // a parent reference pinned to ONE version — never the bare DID
  did: string;
  versionId: string;           // parent's content-addressed versionId at pin time (asserted on resolve)
  versionSequence: number;     // the resolution key: resolveDID(did, { versionSequence })
}

interface AttenuationAssertion {
  issuer: string;              // the attenuating Agent DID
  statement: 'authoritySet ⊆ parent.authoritySet';
  lineageId: string; counter: number;
  authorityCommitment: string; parentAuthorityCommitment: string | null;
  proof: { verificationMethod, proofValue, created, ... };   // keymaster.addProof — signer = verificationMethod DID
}

interface PicBlock {           // the cleartext, written via mergeData/setProperty
  lineageId: string;           // origin's own DID; stable down the chain
  counter: number;             // parent + 1; origin = 0
  prevCredential: PrevPin | null;             // null at origin
  authorityCommitment: string;                // this hop's salted commitment
  parentAuthorityCommitment: string | null;   // the parent's own commitment (chain consistency)
  attenuationAssertion: AttenuationAssertion;  // signed
}
```

### Canonical commitment (reproducible by any verifier)

`commit(authoritySet, salt) = sha256( canonicalize({ authoritySet: normalize(authoritySet), salt }) )`

- `canonicalize` — a fixed **RFC 8785 / JCS subset** (recursively sorted object keys, compact separators)
  adequate for our value space (strings, string arrays, integers, null). Fixing the form now makes every
  commitment reproducible independently.
- `normalize` — dedupe + sort `operations` and `resources`, so the commitment is order-independent.
- **Salt = 32 random bytes (256 bits)** — the authority-set space is tiny and would be brute-forceable
  unsalted (see the SALT result).

### Verifier checks (walks leaf → origin, resolving through a configurable Gatekeeper)

Per hop, **public resolution + signature only** (no decryption unless disclosure is supplied):

- **(a)** the hop resolves and has a `controller`;
- **(e)** its `attenuationAssertion` verifies **and is signed by that controller** (the expected issuer);
  the signed fields must match the pic (no split-brain);
- **(b)** the pinned parent resolves at `versionSequence` **and its content-addressed `versionId` matches
  the pin**;
- **(c)** `counter == parent.counter + 1`;
- **(d)** `parentAuthorityCommitment == parent's OWN authorityCommitment` (commitment chain consistent);
  `lineageId` stable across the hop.
- **Optional stronger check** (on disclosure of `authoritySet+salt`): recompute `commit == authorityCommitment`
  (bind the reveal) **and** enforce `Cᵢ₊₁ ⊆ Cᵢ`.

---

## Results — every case produced the expected verdict (live)

Chain built for the run: `C0{read,write on X} → C1{read on X} → C2{read on X}` (lineage L1).
Verifier ran on a **separate node handle** (third-party posture; resolution only).

| # | Case | Expected | Verifier output (verbatim) |
|---|---|---|---|
| 1 | HAPPY — structural, no decryption | ACCEPT | `ACCEPT` |
| 2 | HAPPY — disclosed sets → recompute commitment + ⊆ | ACCEPT | `ACCEPT` |
| 3 | ATTEN-VIOLATION — **structural** (well-formed ⇒ structure alone accepts) | ACCEPT | `ACCEPT` — *the commitment hides the set; subset needs disclosure* |
| 4 | ATTEN-VIOLATION — **disclosed** `{write} ⊄ {read}` | REJECT | `REJECT (⊆) — disclosed child authoritySet ⊄ parent authoritySet` |
| 5 | ATTEN-VIOLATION — **forged** `parentAuthorityCommitment` | REJECT | `REJECT (d) — child.parentAuthorityCommitment != parent.authorityCommitment (commitment chain break)` |
| 6 | COUNTER-SKIP — `counter = parent + 2` | REJECT | `REJECT (c) — counter 3 is not parent 1 + 1` |
| 7 | PREV-TAMPER — **pinned** versionId | ACCEPT | `ACCEPT` (unchanged after the parent was tampered) |
| 8 | PREV-TAMPER — **bare** DID follower | REJECT | `REJECT (d) — bare parent commitment ≠ child.parentAuthorityCommitment` |
| 9 | CROSS-LINEAGE — pin C1(L1), claim L2 lineage | REJECT | `REJECT (lineage) — lineage mismatch: child <L2-did> vs parent <L1-did>` |
| 10 | FORGED-ASSERTION — signed by a non-Warden key | REJECT | `REJECT (e) — attenuation assertion signed by <attacker>, not the hop's controller/issuer <warden>` |
| — | DISCLOSURE — holder decrypt → verifier rebinds | ACCEPT | `holder decrypted C1 = {read on X}; recomputed commitment MATCHES authorityCommitment` |
| — | SALT — commitment non-reversibility | (non-enumerable) | `over 64 candidates: unsalted recovered the preimage (1 hit), salted recovered 0` |

> **The honest core finding (rows 3–4).** A hiding commitment means the *structural* verifier proves **chain
> integrity** — pinning, counter, commitment consistency, signatures — but **cannot judge subset**: an
> over-broad child with a well-formed chain is structurally valid. Subset (`⊆`) is enforceable **only when
> the holder discloses** `authoritySet+salt`, at which point the commitment binds the reveal and the `⊆`
> check fires. Two independent defenses catch the two attacks: disclosure catches an *honest-commit*
> over-broad child (row 4); the commitment chain (d) catches a *forged* `parentAuthorityCommitment` (row 5).

---

## PREV-TAMPER — pinned versionId vs bare DID, side by side

After building `C0{read,write} → C1{read}`, the parent **C0 widened its own `authorityCommitment`** via a
second `mergeData` (a new `versionId`, `versionSequence` 2 → 3). Same parent DID, two versions:

```
child.parentAuthorityCommitment      = 5e45f9240610c3b40f7af833995915c1229b8b0a305c0e51245962eeaba897ec
pinned  seq 2  authorityCommitment    = 5e45f9240610c3b40f7af833995915c1229b8b0a305c0e51245962eeaba897ec   (== child ✓ ACCEPT)
bare    latest authorityCommitment    = 9088ddfc9e07c7e73f172333783f4fe7fcbac5fda190f4032bb7eb2d52e72c15   (≠ child ✗ tamper visible)
```

- **Pinned walk (the verifier's actual behavior):** the child pinned `C0 @ versionSequence 2`; resolving that
  version returns the **immutable original** pic, whose `versionId` and `authorityCommitment` match the pin →
  **ACCEPT**. The parent's later self-widening is invisible to the child's proof — exactly right.
- **Bare-DID follower (the naive alternative):** resolving `C0` bare returns the **tampered latest**, whose
  `authorityCommitment` no longer matches the child's `parentAuthorityCommitment` → the chain breaks at **(d)**.

This is the whole point of pinning: **the parent cannot retroactively widen the authority a child attenuated
from.** Old `versionId`s persist and stay resolvable, so the change is tamper-**evident**, and the child binds
to the exact historical version it descended from. Pinning is load-bearing; a bare-DID reference is not safe.

---

## Reproducing

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass' HEARTHOLD_REGISTRY=local \
       HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 \
       HEARTHOLD_DATA_ROOT="$(mktemp -d)"    # isolated wallets/vault
npm run e2e:attenuation
# → "✓ all cases produced the expected verdict"  (exit 0)
```

Every DID in a run is minted on `registry: local` (hygiene; never hyperswarm). Because assets are permanent
on the node, each run mints a fresh lineage — the DIDs above are from one representative run.
