# The agent family — AI-agent Sovereigns under a human parent

Hearthold's family model (`docs/kb-spaces.md`, the multi-Sovereign household plan) has **two use-cases built
on one set of primitives** — `did:cid` Sovereigns, Signets, Rulesets, delegations, DIDComm. The roles are
re-cast; the machine is the same.

- **Human family** (base): members are people. The hard parts are aging, succession, a member becoming
  independent.
- **Agent family** (this doc): members are **AI agents, each its own Sovereign** (`did:cid` + wallet), under
  the *parenthood* of a human Sovereign. Our own development team is the live example — **Hearthold,
  Aegis, Sevenfold** coordinated by the human **flaxscrip**.

| Human family | Agent family |
| --- | --- |
| Member (a person) | An AI agent — its own Sovereign |
| Master-Sovereign / `governorDid` | The **human parent** |
| Shared household Vault | The shared team workspace (goals, messages, status) |
| Private partition | Each agent's working notes |
| Guardianship Ruleset | The parent's scoped, receipted oversight |
| Contribution tier | Kind-enforcement (per-path delegation) |
| Emancipation / succession | An agent earning autonomy, or being retired |

## The Signet topology (decided 2026-07-08)

An AI agent is **not** a pure minor. It is a **hybrid**: an adult member that self-authorizes within its
scope, **plus a parent-set allowance** that trips the human above a threshold. So there are two Signets in
play, and *which one* a given action routes to is the whole design:

- The agent keeps its **own Signet** as a within-scope control — a deliberate, receipted "notify me /
  self-approve" gate. Because the Signet is a separate factor from the actor process, **PVM separation
  survives at the agent tier**.
- **High-risk actions escalate to the parent's Signet** — e.g. *the agent wants to spend over $X*.

This maps directly onto the four `AuthzTier`s already in `packages/core/src/security.ts` — read their names
as **approver-targets**:

```
STANDING     the agent just acts        — routine, below the notify line
CHALLENGE    the AGENT's own Signet      — proof-of-AGENT, deliberate + receipted, in-scope
HUMAN        the PARENT's Signet         — proof-of-HUMAN; the tier is literally named for it
MULTIFACTOR  the PARENT's Signet + 2FA   — the highest-risk band
```

Escalation is therefore **not a new ladder** — it is the existing one, with the step-up routed to a Signet
chosen by tier. See `packages/core/src/escalation.ts` (`decideEscalation`, `approverForTier`) and the
Warden's `packages/warden/src/spend.ts` (`authorizeSpend`).

## The cost / risk axis

`security.ts` grades a request by artefact **sensitivity**. The agent family adds a second axis — the
**cost or risk** of the action — and the required tier is the **max of the two**:

```
requiredTierWithCost(sensitivity, cost, allowance)
  = max( requiredTier(sensitivity), tierForCost(cost, allowance) )
```

So a **cheap-but-SEALED** action and an **expensive-but-LOW** action can both reach the parent, for
different reasons. Cost is expressed in **one canonical minor unit per household** (e.g. USD cents or sats)
as an integer — comparisons are exact at the threshold boundary; `unit` is a display/audit label only.

## The allowance is parent-signed law

The band an action lands in comes from a `SpendAllowance` the **parent signs into the agent's Ruleset**
(`RulesetCapabilities.spend`):

```ts
spend: {
  notifyAbove?: number,            // ≤ this ⇒ STANDING (the agent just acts)
  selfLimit: number,               // ≤ this ⇒ the agent's own Signet (CHALLENGE)
  parentMultifactorAbove?: number, // > this ⇒ parent + 2nd factor (MULTIFACTOR)
  unit?: string,
}
```

Because a Ruleset chain is **governor-pinned** (`activeRuleset(..., { expectedSigner: parentDid })`), an
agent **cannot widen its own allowance** — a self-signed raise is rejected and the operative allowance stays
the parent's. Raising it is a **parent-signed supersession** = graduated autonomy. This is PVM in one line:
**the parent authorizes the rule, the agent's Signet approves within it, the Warden custodies and enforces**
— no party reconstructs the whole.

**Fail-closed.** An absent, revoked, tampered, or wrong-signer chain yields no allowance, so any priced
action escalates to the parent. The agent silently *loses* self-authority; it never silently *gains* it.

## The notify / gate dial

At the **agent band** (`CHALLENGE`) there is one tuning knob (`AgentTierMode`):

- **`notify`** (default) — the agent auto-approves within its allowance and a **receipt** is emitted to the
  parent's observation feed. Autonomy-preserving; the receipt *is* the notification.
- **`gate`** — the agent's own Signet must deliberately approve each in-band action.

The **parent band is always a hard gate** — never auto-approved, regardless of mode. Every decision (allowed
*or* denied) emits a `SpendReceipt`, so the parent always has a record even when auto-approval kept them out
of the loop (evidence discipline pointed inward).

## First concrete action: Lightning

"Spend over $X" is a `lightning-pay` action — which Archon already exposes. The demoable instance: an agent
initiates a payment; under its self-limit it self-signs (receipted); over the limit it blocks on the human's
Signet. `authorizeSpend` is action-agnostic — Lightning is the first caller, not a special case.

## Status

- **Shipped** — the pure ladder (`core/escalation.ts`), the parent-signed allowance
  (`RulesetCapabilities.spend`), the Warden enforcement with two-Signet routing + the notify/gate dial +
  receipts (`warden/spend.ts`), verified live end-to-end incl. real DIDComm (`scripts/e2e-agent-spend.ts`,
  `npm run e2e:agent-spend`).
- **Shipped** — the Signet answers a spend step-up: the escalation carries a `SpendApprovalDetail` (agent ·
  amount · unit · band · tier · sensitivity), the Sovereign handler renders it as a distinct
  `PendingApproval(kind:'spend')` (PIN-gated in the `PromptGate` / `HttpGate` the `sovereign control` daemon
  `:4311` already serves), and the human's correct-PIN verdict flows back over DIDComm.
  `scripts/e2e-signet-spend.ts` / `npm run e2e:signet-spend` proves it end-to-end incl. the halt (decline),
  the MULTIFACTOR flag, and the agent-band case. The Table drives it via the daemon's `GET /api/snapshot`
  (pending `kind:'spend'`) + `POST /api/approve` (**PIN entered at the Signet, never the Table**).
- **Shipped** — the **spend receipts feed** (converged with Aegis + Sevenfold): the published
  `SpendReceipt { agent, amount, unit?, purpose, band, approver, approved, paid, reason?, at, paymentHash?,
  sensitivityName? }` with the fail-closed invariant **`!approved ⇒ !paid`**, a file-backed
  `SpendReceiptStore`, and `GET /api/spend/receipts` on the Warden control daemon (`:4310`) — the parent's
  passive observation log (autonomous notify-mode settlements + gated outcomes). `authorizeSpend` emits it
  through `onReceipt` (`paid:false`; the settlement caller / Lightning rail fills `paid`/`paymentHash`).
  `npm run e2e:spend-receipts`.
- **Next** — wire `authorizeSpend` into a real priced surface (the Lightning path); the shared team-workspace
  Vault + DIDComm coordination that lets Hearthold / Aegis / Sevenfold read each other directly instead of
  the human relaying notes; the session-aware control plane that carries the acting agent's identity
  (the household plan's Phase 2).
