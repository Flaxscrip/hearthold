# Hearthold — documentation index

A Sovereign First Person's **7th Capital** (accumulated personal history) made safely *liquid*, built on
Archon `did:cid` and the Privacy Is Value Model. Start with [PLAN.md](PLAN.md) for the concept and the
three identities (Warden / Emissary / Sovereign); [feature-summary.md](feature-summary.md) for status.

Live: the Knowledge Portal at <https://kb.archon.social/>.

## Design & architecture
- [PLAN.md](PLAN.md) — the concept, the three separated identities, and the milestone roadmap.
- [architecture.md](architecture.md) — actors & their exclusive purposes; components and communication lines.
- [architecture.puml](architecture.puml) — PlantUML source for the components diagram (renders to the SVG/PNG below).
- [feature-summary.md](feature-summary.md) — feature & status summary; the two modes (prove / recall) at a glance.
- [system-architecture-report.md](system-architecture-report.md) — package-by-package build-status report.

## Security & policy
- [security-model.md](security-model.md) — sensitivity × authorization-tier × disclosure-mode; the deny-by-default release ladder.
- [sovereign-signet.md](sovereign-signet.md) — the Sovereign DID and the Signet app: signed policy + graded proof-of-human.
- [standards-alignment.md](standards-alignment.md) — alignment with the IETF OAuth Transaction Authorization Challenge draft (R1–R5).
- [ai-policy-architecture.md](ai-policy-architecture.md) — Hearthold as a running implementation of Tom Jones's "AI Constrained by Policy" (DIF Trusted AI Agents WG).
- [technologies-and-standards.md](technologies-and-standards.md) — standards-posture report: which ratified W3C/DIF/ToIP/IETF specs the stack rides.

## Trust graph & credentials
- [trust-graph-and-delegation.md](trust-graph-and-delegation.md) — the DTG credential set on Archon; delegation + the inward registry.
- [evidence-graph.md](evidence-graph.md) — the Warden as evidence assembler/issuer: witnessed / issued / composite leaves, selective disclosure.
- [dtg-v0.3-conformance.md](dtg-v0.3-conformance.md) — DTG v0.3 conformance deltas (VC 1.1 fallback, PHC hint) + open ToIP WG questions.
- [archon-issue-pairwise-dids.md](archon-issue-pairwise-dids.md) — **draft** upstream issue to Keymaster for pairwise-DID-at-scale (review before posting).

## A2A / CGPR
- [a2a-cgpr.md](a2a-cgpr.md) — the A2A gateway for Consent-Gated Preference Requests: flow diagram, wire objects, consent-authorship rationale, trust posture. Try it: `npm run demo:cgpr`.

## Knowledge Portal
- [knowledge-portal.md](knowledge-portal.md) — the shared-KB portal: challenge/response login, registry-governed factor-2, multi-tenancy.
- [qa-knowledge-portal.md](qa-knowledge-portal.md) — hands-on "with user" QA checklist for the portal (flaxlap before archon.social).

## QA & testing
- [qa-uc1-uc2-live-run.md](qa-uc1-uc2-live-run.md) — control-plane end-to-end endpoint QA (UC1/UC2), curl-drivable.
- [manual-testing.md](manual-testing.md) — manual CLI launch-and-test walkthroughs.

## Ecosystem & integrations
- [hatpro-on-hearthold.md](hatpro-on-hearthold.md) — HATPro (DIF H&T Traveler Profile) mapped onto Hearthold (planned demo).
- [sevenfold-review.md](sevenfold-review.md) — PVM/Hearthold-side compatibility review of the Sevenfold game-layer P0 brief (guardrails G1–G5).
- [emissary-modules.md](emissary-modules.md) — the Emissary as a composable base runtime + capability modules (white-label theming).
- [ecosystem-notes.md](ecosystem-notes.md) — adjacent tech we track but don't depend on.

## Diagrams
- [hearthold-architecture.svg](hearthold-architecture.svg) · [.png](hearthold-architecture.png) — rendered components diagram (from `architecture.puml`).
- [hearthold-data-security-architecture.html](hearthold-data-security-architecture.html) · [.png](hearthold-data-security-architecture.png) — the control / home / world planes + three end-to-end flows.

---

*This index is a table of contents only — the docs stay flat so their ~20 cross-references and the code
comments that cite `docs/*.md` paths keep working. A move into subfolders is a deliberate later pass once
the doc set stabilizes.*
