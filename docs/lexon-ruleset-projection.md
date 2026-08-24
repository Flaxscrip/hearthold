# Lexon as the Normative Layer — Design Note (v0.1)

**Date:** 2026-07-13 · prepared by GenitriX, captured at flaxscrip's direction
**Source reviewed:** https://guide.agentprivacy.ai/lexon/welcome-visitors (the Grammar Workshop — Lexon × PVM) · source of truth `github.com/mitchuski/lexon_pvm` · harness instance #5 (`HARNESS_PATHS.md`)
**Status:** design thread — post-seat-signature experiment queued; no code, no decisions reopened.

---

## 1. What Lexon brings

Lexon (Henning Diedrich's controlled English for computational law) makes one sentence three things at once: **plain English a signer can read, an executable contract, and knowledge-graph triples carrying a machine-checkable claim.** The Grammar Workshop proved it at scale against our own theory-base: 189/211 PVM canon terms expressed and gate-verified (parse → triple round-trip → role binding → promise typing), each claim required to **fail on its own mutated twin** — so "this boundary cannot be crossed by design" is not prose, it's a query that provably returns nothing. The harness even carries its own constitution (TRUSTS T1–T6, seven seat cards) as thirteen verified Lexon promise bundles — including semantics we own: *trust gates that forbid self-approval*, *the door as a gate no seat may self-declare*.

## 2. The boundary that keeps this clean (write it down before anyone conflates them)

| | Lexon | CantripTalk (Sevenfold decision #1/#6 — **unchanged**) |
|---|---|---|
| Nature | **Normative** — obligations, permissions, promises | **Behavioral** — event handlers, conditionals, proposals |
| Can say | "The Mage may never receive the key" | "When two cards touch, propose an annotation" |
| Verified by | Grammar gate + mutation probe (claims falsifiable) | Fuel-limited interpreter + Warden egress checks |
| Role in our stack | What actors **are bound to** | What actors **do** |

Complementary layers: a cantrip's *capability manifest* could one day be Lexon; its *handlers* never will be. Decision #1 stands.

## 3. Where Lexon lands in Hearthold (two seams, both high-value)

**3a. Rulesets → Lexon projection.** Rulesets today are structural JSON — deterministic, signed, chain-verified, but human-readable only through rendering. A Lexon projection makes the "law of the house" **readable at the Signet as English while staying machine-verifiable**: the purple card shows the *actual law*, not a summary. The Signet's composite "law of the house" view (architecture decision #7) becomes a document a person reads, a checker verifies, and a mutation probe falsifies. Discipline: JSON stays the enforcement source of truth initially; the Lexon form is a *projection with a verified-equivalence claim* (the projection's triples must round-trip to the same capabilities/ceiling/assurance — a mismatch is a gate failure, not a footnote).

**3b. Consent text → controlled grammar.** The Warden-authored consent sentence is currently honest prose. In Lexon it becomes **checkable against the grant actually minted** — closing the last gap between what the human read and what the system did. This is the strongest external story: it upgrades our "the Warden authors all consent text" rule (already our differentiator in the CGPR work) from *trustworthy author* to *verifiable equivalence*, speaks directly to MyTerms/IEEE 7012 (already a harness instance), and answers Tom Jones's "policy in machine-readable format" with the one property Cedar/OPA/ODRL lack: **the signer can read it.**

## 4. First experiment (cheap, queued post-signature)

Express the **workshop genesis Ruleset** (`hearthold_mage/notes/workshop-ruleset-v1.json` — the smallest real policy document we have, freshly Sovereign-signed) as Lexon entries against the public `lexon_pvm` spec-checker, reusing the SG-1..SG-6 authoring conventions (modal mapping, trust gates forbidding self-approval, single-officiant ceremony chains). Exit: the entries pass the base gate and every relation claim survives its mutated twin. If it verifies, the Ruleset→Lexon projection is prototyped on real material and §3a gets a build decision; if it doesn't, we file *why* — either way we learn the fit for the price of an afternoon.

## 5. Adjacent bookmarks

- **Structured Language Blocks** (their deterministic write-path for a shared public knowledge graph): the right substrate for the deferred **City-of-Mages collaboration KB** — contributions as verified-claim blocks, not free text; the KB becomes self-auditing. Revisit when the Hearthold Federation model lands.
- **City Pact:** Lexon term entries are natural dual-pin artifacts (CID + did:cid); add to the housekeeping list (V-item) when the pact convenes.
- **DIF Trusted AI Agents:** if the §4 experiment lands, a one-slide follow-up to the Tom Jones material: "the policy the human signs is the policy the machine checks — same bytes."

## 6. Open questions

1. Projection vs source: long-term, does Lexon *become* the Ruleset source (compiled to the JSON the Warden enforces), or stay a verified projection? (Lean: projection until the checker toolchain is ours to run in CI; the enforcement path must never depend on tooling we can't pin.)
2. The real Lexon compiler is macOS-only/unpublished (the workshop's own honest regime label) — the spec-checker is the gate we'd rely on; is that sufficient for consent-equivalence claims, or does 3b wait on a published compiler?
3. Vocabulary: our Ruleset terms (actor, kind, verb, ceiling, assurance) need census entries of their own — coordinate with PrivacyMage so they enter *his* canon once, not our fork of it.
