# Capabilities governance — Hearthold as a decentralized reference implementation

**Status:** positioning note (2026-08-13). Maps Hearthold onto the **Janssen Project's** Token-Based
Capability Access Control (TBAC) governance agenda, names the architectural fork, and sketches the interop
+ standards opportunity. Companion to `invocation.md`, `security-model.md`, `invocation-dashboard.md`.

## Why this note

The **Janssen Project** (Linux Foundation's open-source IAM stack — the OAuth/OIDC/UMA/FIDO reference
platform, ex-Gluu) has published a design-discussion doc,
[*Capabilities Governance Infrastructure*](https://github.com/JanssenProject/jans/wiki/Capabilities_Governance_Infrastructure_Prompt),
asking: **as enterprises move from role-based (RBAC) to capability-based (TBAC) access control, what
governance tooling will they need?** It proposes ten tool categories and concludes TBAC governance is a
sound but **3–5-year** enterprise undertaking, built on **Cedar** policy + **SMT** formal verification + VCs
+ JWT/X.509 tokens.

The signal for Archon/Hearthold: a major LF IAM project is **independently converging on "capabilities >
roles"** — the exact thesis Hearthold is built on (Alan Karp's four object-capability criteria). Most of what
Janssen frames as a multi-year research agenda, **Hearthold has already built or specified** — on `did:cid` +
object-capabilities + DIDComm rather than Cedar + JWT. This note makes that mapping explicit.

## The ten Janssen governance tools ↔ Hearthold

| # | Janssen TBAC governance tool | Hearthold component | Status |
|---|---|---|---|
| 1 | Capability Registry & Catalog | `core/trust-registry.ts`, `dtg.ts`; MCP `hearthold_list_capabilities`; the roster / DID census | **have** |
| 2 | Capability Composition Engine | attenuation & delegation chains — compose authority by *narrowing* (`capability-chain.ts`, `attenuation.ts`) | **have** |
| 3 | Token Lifecycle Management | `mint_root` → `delegate_capability` → `revoke_hop` / `revoke_capability`; single-use burn (`single-use.ts`); expiry caveats | **have** |
| 4 | Trust Framework Administration | Sovereign-signed **Ruleset chains** (`ruleset.ts`), issuer-attested VCs, `did:cid` as the trust anchor | **have** |
| 5 | Policy Development (Cedar + formal verification) | signed Ruleset authoring; structural attenuation guarantees — **but no SMT/formal proof** | **partial — gap** |
| 6 | Policy Lifecycle Management | `verifyRulesetChain` + amendment-class verification (fail-closed to the prior version on an illegal transition) | **have** |
| 7 | IAM-to-TBAC Bridge (RBAC migration) | — Hearthold is greenfield; **no RBAC-migration story** | **gap** |
| 8 | Governance Workflow Engines (approvals) | the **Signet / AgentGate escalation ladder**; discharge co-sign; deny-by-default release | **have** |
| 9 | Capability Usage Analytics (real-time, anomaly) | the **watch** — lineage forest + A2A flow (envelope + authority only); SSE feeds | **have** |
| 10 | Audit & Compliance Dashboards | the **Sovereign's Invocation Dashboard** (`invocation-dashboard.md`); the daily family DID census | **have (spec'd / building)** |

**Scorecard: ~8 of 10 already realized**, one partial (policy formal-verification), one true gap
(enterprise RBAC-migration bridge). Hearthold is, in effect, a **working reference implementation** of the
governance infrastructure Janssen describes as a 3–5-year enterprise research problem.

## The architectural fork — centralized-token vs decentralized object-capability

The convergence is on the *thesis* (capabilities > roles); the *architecture* diverges cleanly, and that
divergence is Hearthold's differentiation.

**Janssen / TBAC — centralized token + central policy engine:**
- an authority issues a bearer **token** (JWT / X.509 / VC);
- a central **Cedar** policy engine evaluates the token against policy at each call;
- **SMT solvers** formally prove policies can't be exceeded;
- governance = administering the token store **and** the policy store.

**Hearthold — decentralized object-capability, no central policy engine:**
- the capability **is** a signed VC on a content-addressed DID; it **carries its own authority + caveats +
  revocation pointer** (macaroon-style);
- it is verified **at the point of use** by the resource's own **Warden** (the reference monitor), against the
  presenter's holder-proof — no central evaluator;
- **attenuation is monotonic by construction** — a delegate can only narrow; widening is *unrepresentable*, so
  there is nothing for a solver to disprove;
- revocation is a per-hop status the Warden checks fail-closed; the kill-switch reaches the whole subtree.

The one-line contrast: **they need Cedar + SMT to *prove* a token can't exceed policy; Hearthold makes
over-reach *unrepresentable* in the capability object itself.** Karp's four criteria, realized structurally,
versus enterprise-IGA framing realized by a policy engine.

Corollary: Janssen's "policy" and "token" are two stores to govern; Hearthold fuses authorization into the
capability object, so there is one artifact to mint, attenuate, present, and revoke. Fewer moving parts, no
central chokepoint, offline-verifiable.

## What Hearthold should take from this

Three concrete things — stated honestly, not as validation-seeking:

1. **The ten-tool taxonomy is an excellent gap-map.** Our real gaps against it are:
   - **Formal verification of policy (#5).** We enforce attenuation-narrowing and legal Ruleset transitions
     *structurally*; Janssen would *prove* them with Cedar + an SMT solver. A machine-checkable proof that
     "no delegation in this chain widens authority" or "this Ruleset amendment is legal" is a legitimate
     addition **on top of** our structural guarantees — belt and suspenders for high-assurance deployments.
   - **RBAC→capability migration bridge (#7).** Hearthold is greenfield; we have no story for an org running
     RBAC today. Not needed for the household/agent-family model, but it *is* the gap if Hearthold is ever
     pitched into an enterprise.

2. **UMA / GNAP interop is a real, buildable opportunity.** Janssen/Gluu **are** the UMA (User-Managed Access)
   people, and UMA/GNAP is precisely *"a user delegates scoped, revocable access to their resources to a
   third party"* — which is Hearthold's **Sovereign → Emissary / aggregator** delegation in enterprise-standard
   clothing. A **"Hearthold capability ⇄ UMA/GNAP grant"** adapter (the pairwise-DID audience ↔ the UMA
   requesting party; the caveat set ↔ the UMA scopes; the Warden ↔ the UMA resource server) is a concrete
   interop demo that speaks to the enterprise IAM world in its own protocol.

3. **Standards positioning for the Archon mission.** This is a **Linux Foundation** adjacency, mirroring the
   **ToIP / LFDT** adjacency of Mitchell's DTG ZKP work (`NOTE-privacymage-dtg-zkp-convergence.md`). Two
   credible standards worlds — LF IAM and ToIP identity — are **both** converging on capabilities + verifiable
   credentials. Archon/Hearthold positioned as the **decentralized reference implementation that interops with
   both** is a genuine strategic slot for the ecosystem (loop macterra). We are not chasing a trend; two
   independent bodies are arriving where Archon already is.

## Honest limits

- Janssen's doc is **enterprise-IGA-flavored** — SailPoint/Okta/AD migration, compliance dashboards,
  org-scale sprawl detection. Much of that is plumbing the household / agent-family model doesn't need.
- **Cedar is a centralized-policy paradigm we deliberately don't use.** Adopting it wholesale would undo the
  decentralization that is Hearthold's point. We take the *taxonomy* and the *formal-verification idea*, not
  the architecture.
- The Janssen page is a **design-discussion / LLM-analysis doc**, not a ratified spec — so this is convergence
  and opportunity, not a standard to conform to (yet).

## Next steps

- **Publish** a short comparison artifact (the ten-tool mapping + the architectural fork), in the house visual
  grammar — an Archon-mission piece showing Hearthold is ahead of a 3–5-year enterprise agenda.
- **Spike** the UMA/GNAP ⇄ capability adapter (the smallest real bridge: one capability presented as a UMA
  grant to a UMA-native resource server).
- **Scope** an optional formal-verification pass over a delegation chain / Ruleset transition (SMT proof of
  no-widening) as a high-assurance add-on to the structural guarantees.
- **Outreach:** a note to the Janssen/UMA community + macterra on Archon `did:cid` as a decentralized
  capabilities-governance substrate that interops with TBAC.
