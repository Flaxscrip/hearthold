# Hearthold — Guardianship & Governor-Overreach Threat Model

**Date:** 2026-07-16 · authors: flaxscrip (Sovereign) + GenitriX · **Status:** design, feeds the family-model build (`plan-under-review.md`)
**One-line principle this document establishes:** *Guardianship is grantable but never seizable.*

---

## 0. Read this first if you are mid-build (the one thing that changes today)

The family plan is sound and building may continue. **One instruction changes**, and it's cheap to honor now / expensive to retrofit later:

> **A private partition MUST be encrypted to its member's own key, not merely gated behind a Warden-side group/`testVault` check.** The group check is the *policy* boundary; the member-key encryption is the *cryptographic* boundary, and only the latter survives a rooted governor (Adversary B). If `household-vault.ts` / `provisionMemberPartition` are being written this week, wire member-key encryption into the private-partition write/read path from the start.

Everything else here is a Phase-4/5 verifier rule + e2e vectors; it does not block Phases 0–3. Share tomorrow as planned — but drop the dev the one line above tonight so the private-partition storage seam is built right the first time.

## 1. The scenario

- **Stage 1 (legitimate):** the Governor-Sovereign signs a household Ruleset enabling per-member private KBs. Members join; each private partition is theirs.
- **Stage 2 (the attack):** the governor, *without the members' permission*, appends a new Ruleset version granting the governor read access into members' private partitions — then reads.

The question: does the design prevent this, and is preventing it desirable?

## 2. Split the adversary — they need different answers

### Adversary A — the Governor as protocol-abiding role-holder
Holds the governor key; plays *within* the system (signs a valid-looking v2, lets the Warden serve it). **Fully preventable in software.**

### Adversary B — the Governor who owns and roots the hardware
Holds the governor key **and** controls the Warden host (reads storage at rest, patches the binary, disables checks). **Not absolutely preventable by software** — but made to cost real cryptography, and to leave unforgeable evidence.

## 3. Defense against Adversary A — amendment-class verification

**Today's gap (honest):** `verifyRulesetChain` checks that each version is signed by the pinned governor and links to its predecessor. A governor-signed v2 that widens the governor's own access therefore *verifies* — so the Warden would honor it. The chain is append-only and auditable, so members could eventually *see* v2 — but detection **after** disclosure is not privacy.

**The fix — verify the legality of the *transition*, not just the signature.** Classify every Ruleset amendment; require different signers per class:

| Amendment class | Example | Sufficient signer(s) |
|---|---|---|
| **Governor-domain** | shared-space policy; admit a member on agreed terms; governor *narrows* their own access | governor alone |
| **Self-restricting** | any change that only *reduces* access | the party losing nothing; governor alone if it's theirs |
| **Guardianship (access-widening into a member's private data)** | grant governor read of member M's private partition; raise a guardianship ceiling over M | **governor AND member M's acknowledgment signature, both in the chain** |

**The rule, stated for the verifier:** a Ruleset transition whose net effect *widens any principal's read/authorization reach into another principal's private scope* is **invalid unless the affected member's signature is present in that transition.** No member signature → the transition does not verify → the Warden **fails closed to the prior version**, exactly as it rejects an unsigned downgrade today.

Why this is airtight against A: it moves the dual-signature requirement from *"how guardianship is created (the admit flow)"* to *"what the chain verifier structurally requires."* The governor cannot route around the admit flow by editing the Ruleset directly, because the *verifier* — the same one governor-pinning already hardened — rejects the edit. It is the Stage-1-solution (a rooted **Warden** can't rewrite its law) generalized to Stage 2 (a governing **Sovereign** can't rewrite the constitution over a member's head).

- **Adult member:** the acknowledgment signature is a genuine co-sign — disclosed-monitoring consent, which is also what employment/roommate law generally requires.
- **Minor member:** the guardian *legitimately holds* the signature that co-signs on the child's behalf — and **that is the definition of guardianship, not a loophole.** The distinguishing line is §5.

## 4. Defense against Adversary B — cryptographic floor + unforgeable evidence

A person with the governor key, the Warden process, and root cannot be stopped by policy code they can patch out. Two measures make the attack cost cryptography and leave proof:

**4a. Member-key encryption of private partitions (the §0 instruction).** Each private partition's content is encrypted to the *member's* key, not merely gated by a Warden group check. A rooted Warden serving an unauthorized read then returns **ciphertext the governor cannot open.** The guarantee degrades from *"policy forbids it"* to *"cryptography forbids it"* — the strongest a home server offers, and the same principle as the vault being sealed at rest, now refusing to exempt the household's own administrator. (Note the honest residual: the local model must transiently see plaintext to answer a member's *own* query; member-key encryption protects data at rest and against cross-member reads, not against a governor who has fully subverted the live query path for a logged-in member's session. That last case is out of reach of any single-box design and belongs to the federation roadmap — §6.)

**4b. Unforgeable betrayal evidence.** The append-only signed chain means an illegitimate v2 is caught two ways: it either **lacks the member's signature** (rejected under §3), or — if the attacker forges the whole history to fabricate consent — the **hash linkage breaks** against the copy the member's own device and any external verifier pinned. A governor can betray, but cannot betray *and appear not to have.* Betrayal becomes unstoppable-but-unforgeable at worst, and prevented at best.

**4c. Access receipts (inward evidence).** Every guardianship read emits a transaction record delivered to the watched member — the evidence discipline turned inward. The watched can see the watching; a governor who suppresses receipts has left the protocol (and, per 4b, cannot hide that they did).

## 5. Is it desirable? — the grantable/seizable line

The *capability* — a governor lawfully gaining member visibility — is desirable and already blessed (guardianship: a parent must, an employer may with consent). What is undesirable is that capability arriving **unilaterally and silently.** So:

> **Guardianship is grantable but never seizable.** A governor may hold power over a member's data only through a transition the member's own key participated in — by co-signing (adult) or by being the key the guardian legitimately holds (minor) — rendered **visibly** on the member's surfaces, **receipted** on every use, and **expiring**.

This is the property that makes the same Ruleset machinery express *both* the benevolent case and its refusal of the malignant one. A parent/child guardianship and an attempted governor land-grab differ by exactly one thing the system can check: **whose keys are in the transition.** That is not a policy nuance bolted on — it is the PVM separation holding at the household's most intimate boundary.

## 6. Residual risks named honestly (for the security model + DIF/WG audiences)

1. **Single-box governor with root over a live session** (§4a residual): unreachable by any single-Warden design. Mitigation is the **operator-private federation** already seamed in `kb-spaces.md` (`PartitionLocation: 'remote'`) — a member's private partition physically lives on *their own* Warden; the household Warden holds only a reference. That's the true fix and it's already on the roadmap; until then, member-key-at-rest + unforgeable evidence is the honest floor, and the deployment guide should say so.
2. **Coerced signature:** a governor who compels a member to co-sign defeats §3 — but this is coercion, outside any software boundary, and the visible+receipted+expiring properties at least make it ongoing and revocable rather than silent and permanent. (`validUntil` + one signed supersession = the member's exit when coercion lifts.)
3. **Minor's growing autonomy:** by design the guardian holds the child's co-sign key. The family chooses when to bring the child into acknowledgment; the system supports staged emancipation via supersession. Not a bug — a feature that must be *documented*, because a system that could hide it would be the wrong system.

## 7. Build deltas (for the family plan)

- **Now (Phase 1 storage seam):** private partitions encrypted to member key (§0 / §4a).
- **Phase 4 verifier:** amendment classification in `verifyRulesetChain` for household spaces; access-widening transitions require the affected member's signature or fail closed (§3).
- **Phase 5 guardianship:** the Guardianship Ruleset spec from `plan-under-review.md`, now backed by the verifier rule above; access receipts; conspicuous member-surface rendering; `validUntil`/supersession.
- **e2e vectors** (`scripts/e2e-governor-overreach.ts`):
  - governor-signed v2 widening into member M's private scope **without M's signature → rejected, Warden serves v1** (the headline test);
  - same transition **with M's acknowledgment → accepted** (guardianship works);
  - forged chain history → **hash-linkage verification fails** against M's pinned copy;
  - rooted-Warden unauthorized read → **returns ciphertext** (member-key encryption holds);
  - every accepted guardianship read → **receipt delivered to M**;
  - expired guardianship Ruleset → **reads refused** past `validUntil`.

## 8. Why this strengthens the whole system

This is governor-pinning's sequel and it closes the arc: Stage-1 protected the law from the enforcer (rooted Warden can't rewrite policy); Stage-2 protects the constitution from the lawmaker (governing Sovereign can't seize a member over their head). Both rest on the same primitive — *verify who signed the transition, not merely that it was signed* — and both fail closed. A household Warden that can prove it *cannot* silently turn on its own members is the version of the family model worth shipping, and the version Tom Jones's "rule of law for agents," the DIF WG, and PrivacyMage's trust framework can each **verify rather than trust.** The custodian stays boring; the constitution stays the members'.
