# Salted-Hash Selective Disclosure — Findings

What worked, what Archon made awkward, and the honest scope boundary. Grounded on **real calls** against a
live node (`@didcid/keymaster` 0.6.0 → `flaxlap.local:4222`, `registry=local`) — the grounding harness is
[`scripts/smoke-disclosure-api.ts`](../../scripts/smoke-disclosure-api.ts) (`npm run smoke:disclosure`).

## Verdict

Buildable on stock Archon, no blocker. A valid subset ACCEPTs; every forgery class REJECTs with the
intended reason; undisclosed properties stay hidden (values **and** names), with the salt provably
load-bearing. Archon stayed dumb — it signed an opaque blob and stored encrypted content; all disclosure
semantics live in Hearthold.

---

## Task 1 — the signed-body-shape answer: **no constraint**

The load-bearing assumption was that the Warden can have Archon sign a Hearthold-defined structured body
(the digest array). Confirmed live, two ways:

- **`addProof` signs any object.** `keymaster.addProof({ sd: [...], issuer, credentialType, validUntil })`
  returned a signed body whose `verifyProof` is `true` and whose `proof.verificationMethod` resolves to the
  Warden DID. This is the primitive the module uses — the same one the codebase already uses for signed
  Rulesets — and its trust is exactly Archon resolution (resolve the signer DID through the trusted
  Gatekeeper), so **no new trust assumption** is introduced.
- **`bindCredential` / `issueCredential` accept the same body.** `bindCredential(holder, { schema, claims })`
  takes `claims: Record<string, unknown>` — an arbitrary JSON object — and `issueCredential` minted a
  credential carrying the digest array verbatim. So Archon imposes **no shape** on the signed body; the
  digest array is a first-class signed payload.

We build on `addProof` rather than the full `issueCredential`/challenge-response VP flow because it gives a
**standalone verification surface**: the endpoint calls `verifyProof(commitments)` and checks the signer,
with no credential-DID lifecycle or VP parsing — and, crucially, the Hearthold `disclosures` ride alongside
the signed commitments in one pairwise-encrypted Presentation, which the credential-level VP flow has no
slot for. (See "awkward" below.)

## What worked cleanly

- **Reused JCS from the attenuation prototype.** `digest = SHA-256(canonicalize({name, salt, value}))` uses
  the same `canonicalize` (RFC 8785 subset) and `freshSalt` (256-bit) exported from `attenuation.ts`, so
  commitments are reproducible by any verifier and the two modules share one canonical form.
- **The signed digest array is tamper-evident for free.** `addProof` signs the whole body including `sd`;
  flipping one digit of one digest breaks `verifyProof` (the TAMPERED-ARRAY case) — no separate integrity
  check needed.
- **Membership binding is exact.** A disclosed `(salt, name, value)` must hash to a digest already in `sd`;
  a forged value or a wrong salt yields a different SHA-256 with no matching entry, so both REJECT at the
  membership check. The holder cannot substitute a second preimage.
- **Hiding covers names, not just values.** Because the digest is over `{name, salt, value}`, an undisclosed
  property leaks neither its value nor its name — only its existence as one opaque entry.
- **Pairwise transport is the existing primitive.** The Presentation is `encryptJSON`'d to the endpoint and
  `decryptJSON`'d on receipt — the same pairwise encryption Archon challenge/response uses — so this
  disclosure model drops straight onto the MCP/A2A transport binding (demo task 7).

## What Archon made awkward (and the workaround)

- **Challenge/response is credential-LEVEL — no slot for extra disclosures.** Archon's VP flow presents a
  whole credential; there is nowhere to attach the selected `(salt,name,value)` disclosures beside it. So we
  do not verify through `verifyResponse`; instead the signed commitments and the selected disclosures travel
  together in one Hearthold-defined `Presentation`, pairwise-encrypted to the endpoint. This is the whole
  reason selective disclosure had to be built into issuance rather than retrofitted at presentation.
- **`createSchema` rejects a bare `{type:'object', additionalProperties:true}`.** It needs `properties` +
  `required`. Irrelevant to the module (we sign via `addProof`), but noted for anyone using the
  `issueCredential` path — supply a real JSON-Schema with `properties`.
- **The digest COUNT is visible.** `sd.length` reveals how many disclosable properties the credential has
  (standard for SD-JWT's `_sd` array). Values and names are hidden; the count is not. If count-hiding is
  required, pad with decoy digests at issuance — not done here.

## IMPORTANT — salted-hash disclosure gives property-HIDING, NOT unlinkability

State this plainly: **salted-hash disclosure does not provide unlinkability.** The issuer signature over the
digest array is a **stable value**, and the full `sd` array ships on every presentation. An endpoint (or two
colluding endpoints) can therefore **correlate repeat presentations of the same credential** by its signature
or its digest set — even across presentations that disclose different subsets. It hides the *undisclosed
property values and names*; it does **not** hide *that it is the same credential presenting again*.

Unlinkability — where each presentation is cryptographically unlinkable to the others and to issuance — is a
separate tier: **BBS+ anonymous-credential disclosure** (per-presentation proofs, not a reused issuer
signature). That is **out of scope** here and is not implied anywhere in this module or its tests. Nothing in
the code or docs should be read as providing unlinkability; if a deployment needs it, it needs the BBS+ tier,
not this one.

## Residuals / next steps

- **Selective-disclosure over the real VC path.** If a relying party requires an Archon-native VP rather
  than the `addProof`-signed commitments, the digest array can be issued as the `claims` of a real VC and
  presented via challenge/response — heavier, and it still needs the disclosures shipped out-of-band
  alongside the VP.
- **Count-hiding** via decoy digests (padding `sd` to a fixed length) if `sd.length` metadata matters.
- **Merkle-tree selective disclosure** — a deferred alternative to the salted-hash array: a signed Merkle
  root plus inclusion proofs, giving log-size disclosures instead of shipping the whole digest set. Same
  property-hiding, smaller presentations; not built.
- **BBS+ anonymous-credential disclosure** — the unlinkable tier, the natural successor when correlation
  resistance (not just property hiding) is required. This module is the property-hiding layer beneath it.
