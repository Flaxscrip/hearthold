# Sevenfold P0 — Hearthold-side compatibility review

**Reviewer:** GenitriX (Hearthold perspective) · **Reviewed:** `Sevenfold/P0-BRIEF.md` +
`game-of-life/Sevenfold-Architecture.md` (v0.2, §7 decision record) · **Date:** 2026-07-08

**Verdict:** strongly PVM-aligned — it inherits the separation correctly (*layers call downward only ·
every call crosses `decideRelease()`*), keeps Table state in a **separate** Archon Vault, uses
**session-end snapshots** (behavioral minimization), and generalizes our factor-2 registry policy into
**Rulesets**. No blocking incompatibilities. The items below are the residue a rigorous downward-
compatibility check surfaces — worth naming before building.

## PVM warnings (ranked)

1. **The axes / City Key are the highest-stakes PVM element — a "score by another name" risk.** A 6-bit
   vertex forged from your vault activity, presentable as a credential, is a compact aggregate profile.
   The Lattice's "never a score — no aggregate-number output type" is in tension with a 6-bit vector.
   P0 is correctly **axes-free** pending the PrivacyMage pact; the pact must ensure the axes/City Key are
   only ever forged locally and disclosed per-vertex through `decideRelease()`, **never presented as a
   standing 6-D profile**.
2. **Derived visual metadata leaks — the veracity border is itself a disclosure.** `veracityOf()` derives
   `mythic`/`royal` from `trustClass: composite`, `isThirdPartyCredential`, and `approval.humanProof.level`.
   A SEALED/obsidian card that still shows a "mythic royal" border leaks *"this hidden card is a
   high-value, human-approved third-party credential."* Make it explicit: **obsidian cards show only the
   seal, never a derived border** (and the `royal` marker must not reveal the approval ceremony).
3. **The Archon-Vault split must never hold card *faces*, only refs.** The invariant *Hearthold's vault =
   what happened to you; Archon Vault = how you arranged it* collapses the instant a cached face is
   written to the Table vault. Guardrail: **Table state = placements + refs (ids/commitments) only,
   never payloads**; faces exist only through a Warden release.
4. **Shared sphere Tables leak card *identifiers* to co-members.** `add_vault_member` shares
   `placements[].ref` (= artefactId | credentialDid | deck name). Even with obsidian faces, the refs
   disclose which cards exist. Use opaque commitments (not resolvable ids) for shared-Table refs, and
   enforce the Table vault's MEDIUM ceiling at the **Warden**, not merely deck policy.
5. **Story mentions expose another Sovereign's DID without their consent** (values tension, not a bug).
   The author's narrative sovereignty is well-served (author-asserted → acknowledged upgrade), but the
   mentioned party has **no un-mention** — their DID is disclosed as associated-with-you regardless.
   For a consent-first system this deserves an explicit blessing from the Sovereign + PrivacyMage.

## Integration gaps (Hearthold must add / reconcile)

- **The Warden must enforce per-actor (cantrip) Rulesets at egress — the interpreter sandbox alone
  doesn't bound data leaving.** "The interpreter IS the security boundary" holds for *compute*; a
  cantrip's network/data egress is only contained if the **Warden** checks each cantrip-originated
  request against that cantrip's Ruleset ceiling. "Cantrip as an authorization subject" is **new Warden
  work** (today: Witnesses via delegations, KB members via groups). This is the #1 build dependency.
- **Card-face hydration is a new Warden release surface** — a scoped "reveal this card face at tier X"
  path, gated by the ladder. Doesn't exist yet (we have recall / evidence / kb).
- **Two policy-on-ledger mechanisms are converging and should be reconciled.** The KB **assurance-policy
  asset** (`createAssurancePolicy` → `createAsset`, recreate-on-change, **unsigned**) vs Rulesets
  (**Sovereign-signed** append-only chains). Rulesets are strictly better (signed + verifiable + audited)
  and should **subsume** the assurance policy — otherwise we grow two divergent "Sovereign policy on
  ledger" stores.
- **Archon Vaults are a new dependency** — Hearthold doesn't use `add_vault_item` / `add_vault_member`
  today; verify member-sharing semantics against warning #4.
- **Package publishing** (`@hearthold/core` + `@hearthold/control-types` external) is mechanical; note
  `core` pulls `@didcid/*` transitively.

## Minor notes

- **Node port topology (corrected):** Drawbridge (public proxy) **4222** · Gatekeeper (DID resolution)
  **4224** · Keymaster holding the *Gatekeeper's* private keys **4226** (rarely/never use directly) ·
  react-native Keymaster wallet, keys in the user's browser **4228** · Herald **4231**. Our services use
  `4222` (Drawbridge) as `nodeUrl`; DID resolution is the Gatekeeper (`4224`); portal login signing is
  the member's **own** wallet (their device / `4228`), never our config. Pin these in the Sevenfold
  config; don't assume `4222`.
- **Possible ZK expectation mismatch** from the older SovereignLife GDD ("ZK range proofs / PVM
  cloaking"): Hearthold does **salted-Merkle selective disclosure + elision**, not ZK. Sevenfold's
  architecture correctly uses Hearthold's rails and is axes-free in P0, so no conflict yet — align
  expectations early if Sevenfold inherits SovereignLife's ZK language.
- The **demo-issuer caveat** (Mark #1 issued by GenitriX vs Warden-issued in production) is already
  correctly self-flagged.

## Bottom line

Nothing blocking. The real Hearthold-side work: (a) name the two disclosure-leak guardrails (obsidian
suppresses the veracity border; the Table vault never holds faces); (b) treat the axes pact as the
highest-stakes PVM decision, keep P0 axes-free; (c) make the **Warden** the enforcer of cantrip Rulesets;
and (d) **converge Rulesets with the KB assurance policy**. The last two are the threads we own — and
(d) is a genuine simplification: one signed, auditable policy mechanism instead of two.
