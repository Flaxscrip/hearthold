# Spec: wiring the AgentGate to a parent-signed allowance

*Design for flaxscrip's sign-off (item 1 of the cleanup; "spec first, then build"). Turns the AI-agent
Sovereign's control-plane Signet from **self-approves-everything** into **bounded self-approval with
escalation to the human parent** — the enforcement behind Sevenfold's "bound not yet enforced" honesty
marker.*

## The gap (today)

`AgentGate` (`sovereign/signet.ts`) takes an optional `permit(ctx) => boolean`. When it is **unset** — which
is the current state — the gate **self-approves every control act**: mint-root, authorize-capability, grants,
disclosures, with no human PIN. The code warns this on boot (`sovereign/control.ts:70-80`): *"the
parent-signed allowance is NOT yet enforced (AgentGate.permit unset)."* So an AI Sovereign is presently
**unbounded over its own control surface**. That is the security gap.

## What already exists (so this is wiring, not new machinery)

The allowance + escalation model is **already built** in `core/escalation.ts` and `warden/escalate.ts`, and
already **deny-by-default**:

- **`SpendAllowance`** — the parent-signed bound: `selfLimit`, `notifyAbove`, `parentMultifactorAbove`.
- **`tierForCost(cost, allowance)`** — *"No allowance ⇒ treat `selfLimit` as 0 (the agent may self-authorize
  nothing), so any non-zero cost lands in the parent band — deny-by-default."* Exactly the safe default the
  AgentGate is missing.
- **`bandForTier` / `approverForTier(tier, topology)`** — routes a tier to `standing` (nobody), the
  **agent's** own Signet, or the **parent's** Signet. `FamilyTopology = { agentDid, parentDid }`.
- **`routeCoSign(transport, topology, tier, req, timeouts)`** (`warden/escalate.ts`) — sends the co-sign to
  the right Signet, **fail-closed** (declined / unreachable ⇒ not approved).

This machinery already governs **disclosures / spend**. It is **not** wired to the **control surface**
(sovereign control acts), where `AgentGate.permit` lives.

## The design

**One principle: an AI Sovereign self-approves only *within* a parent-signed allowance; above it, the act
escalates to the human parent's Signet (proof-of-human) or is refused — never self-approved.**

1. **Bind `permit` from the allowance + topology.** In `sovereign/control.ts`, when `HEARTHOLD_GATE_MODE=agent`,
   construct the `AgentGate` with a real `permit(ctx)` instead of leaving it unset. `permit`:
   - maps the control act (`ctx.action = { action, resource, summary }`) to a required **tier** via an
     **authority table** (below) — reusing `requiredTierWithCost`'s shape;
   - resolves the tier's band via `bandForTier`: `standing`/`agent` ⇒ **within allowance** ⇒ return `true`
     (self-approve, proof-of-agent, L1); `parent` ⇒ **above allowance** ⇒ return `false`.
2. **Escalate, don't just deny.** A `false` from `permit` on the control routes must **route to the parent's
   Signet** via `routeCoSign` (proof-of-human), not silently fail. Above-allowance ⇒ the human parent
   approves, or it's refused (fail-closed). Within-allowance ⇒ agent self-approves + receipts (unchanged).
3. **The allowance is parent-SIGNED and verified.** The agent pins a **parent-signed Ruleset** carrying the
   `SpendAllowance` (+ a control-authority allowance — see decisions), verified against `parentDid`
   (`verifyRulesetChain`, `expectedSigner`), **fail-closed**: unresolvable / wrong-signer / absent ⇒
   `selfLimit = 0` ⇒ **everything above standing escalates to the parent**. A compromised agent cannot forge
   a wider allowance — it isn't the signer.

## Security properties (what this buys)

- **Deny-by-default** — the unsafe "unset ⇒ self-approve everything" flips to "unset ⇒ self-approve nothing
  above standing." Matches the existing `tierForCost` posture.
- **Parent-signed, verifiable, fail-closed** — the bound is the parent's signature, checked; a compromised
  agent can't widen it, and an unverifiable allowance denies rather than allows.
- **Monotonic** — the agent may narrow its own self-limit, never widen it (the parent's ceiling holds).
- **Proof-of-human at the ceiling** — above-allowance control acts reach a real human Signet (the parent),
  the same door/authority line the Table renders: an agent self-approval is never a proof-of-human co-sign.
- **Honest UI becomes honest enforcement** — Sevenfold's "bound not yet enforced" marker can be replaced by
  the real bound once this ships; `SignetStatus` gains a `gateMode` (`human`|`agent`) + the active allowance
  so the Table renders what is actually enforced.

## Open decisions (yours)

1. **The control-act authority table.** How do mint-root / authorize-capability / grant / revoke map to
   tiers? Options: (a) a fixed table (e.g. mint-root & authorize-capability ⇒ parent band by default; a
   scoped grant within a resource ceiling ⇒ agent band); (b) derive from the act's sensitivity/authority the
   same way disclosures derive from `Sensitivity`. **Recommend (a)** — an explicit, auditable table for
   control acts, since "authority of a mint" isn't a sensitivity.
2. **Where the allowance lives.** (a) Extend the agent's existing Ruleset `SpendAllowance` to cover control
   authority; or (b) a dedicated **parent-signed control-allowance Ruleset**. **Recommend (b)** — a distinct,
   parent-signed document so "what the agent may self-grant" is separable from spend and clearly the parent's.
3. **Escalation UX for control acts.** Synchronous (block on the parent's Signet with a timeout, via
   `routeCoSign`) vs refuse-and-queue. **Recommend synchronous** with the existing `factor2` timeout — matches
   disclosures; a timeout is a fail-closed refusal.
4. **Rollout default.** Ship with **no allowance bound** (⇒ deny-by-default: agent self-approves nothing above
   standing, everything escalates) and require an operator to sign an allowance to grant self-authority? Or a
   conservative built-in default? **Recommend deny-by-default** — the safe posture, and it makes binding an
   allowance a deliberate act.

## Build plan (after sign-off)

- `core`: a small `tierForControlAct(action, resource, table)` (the authority table from decision 1),
  alongside the existing `tierForCost`.
- `sovereign/control.ts`: in agent mode, build `AgentGate` with a real `permit` (allowance + topology), and
  route above-allowance control acts through `routeCoSign` to the parent; remove the "NOT enforced" boot
  warning once the bound is live (keep a "deny-by-default: no allowance bound" warning when unset).
- `control-types`: add `gateMode` + active-allowance summary to `SignetStatus` (pairs with `TrinityStatus`).
- e2e (`e2e:agent-allowance`): within-allowance act self-approves; above-allowance escalates to the parent
  Signet (approve → proceeds, decline/timeout → refused); no/forged allowance ⇒ deny-by-default; a widened
  self-signed allowance is refused (not the parent's signature).

**Nothing is built until you sign off on the four decisions.** Once you do, this is a contained change — most
of the model already exists; it's the control surface that hasn't been wired to it.
