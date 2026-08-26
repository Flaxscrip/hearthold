/**
 * The ONE place an AGENT-mode Signet gate is wired to its parent-signed control-allowance.
 *
 * There are two entrypoints that serve an AI-agent Sovereign's Signet — `runSovereignControl` (the HTTP
 * control surface) and the `agent-signet` DIDComm daemon. Both MUST build the `AgentGate` identically, or one
 * path silently self-approves everything (the enforcement gap Aegis caught 2026-08-26: `agent-signet` had
 * built a receipt-only `AgentGate` with no `permit`, so the merged allowance enforcement was unreachable in
 * production). Funnel both through this builder so the predicate can never be forgotten on one path.
 *
 * A CHILD agent (`config.parentDid` set) gets a real `permit` + `escalate`: it self-approves ONLY the control
 * acts its parent-signed allowance names (proof-of-agent), and every other act escalates to the parent's
 * Signet (proof-of-human) or is refused (fail-closed). A ROOT agent (no `parentDid`) has no parent to escalate
 * to — it IS the root of authority — so its gate self-approves (the prior behaviour). Deny-by-default: an
 * absent / unresolvable / wrong-signer allowance grants no self-authority.
 */

import {
  activeRuleset,
  approverForTier,
  bandForTier,
  requestActionApprovalOverDidComm,
  tierForControlAct,
  AuthzTier,
  type ControlAllowance,
  type FamilyTopology,
  type HearthholdConfig,
  type HumanPresenceAssertion,
  type KeymasterHandle,
  type SignedRuleset,
  type Transport,
} from '@hearthold/core';

import { AgentGate, type ApprovalContext } from './signet.js';

export interface AgentGateBuild {
  /** The wired gate — bounded (child) or plain self-approving (root). */
  gate: AgentGate;
  /** A child agent (has a parent to escalate to)? Root agents self-approve. */
  isChild: boolean;
  /** Whether a parent-signed, governor-pinned allowance is actually in force right now (for an honest boot/status). */
  bound: boolean;
  /** The operative allowance resolved at build time (for a status summary), if any. */
  allowance?: ControlAllowance;
  /** The escalation topology for a child agent. */
  topology?: FamilyTopology;
}

/**
 * Build an agent Signet gate wired to the parent-signed control-allowance. Used by BOTH `runSovereignControl`
 * (agent mode) and the `agent-signet` daemon. `onDecision` is the receipt callback (the parent's observation
 * trail); pass the caller's (stderr, or the control server's event feed).
 */
export async function buildAgentGate(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  selfDid: string,
  transport: Transport,
  onDecision?: (ctx: ApprovalContext, approved: boolean) => void,
): Promise<AgentGateBuild> {
  const isChild = !!config.parentDid;
  if (!isChild) {
    // Root agent — it IS the root of authority; self-approve (no permit/escalate).
    return { gate: new AgentGate(onDecision), isChild: false, bound: false };
  }

  const topology: FamilyTopology = { agentDid: selfDid, parentDid: config.parentDid as string };

  // Resolve the OPERATIVE control-allowance under governor-pinning: only a chain the PARENT signed grants any
  // self-authority. Absent / unresolvable / wrong-signer ⇒ undefined ⇒ deny-by-default. Re-resolved per act so
  // a parent-signed supersession (widened, narrowed, or revoked allowance) takes effect without a restart.
  const resolveAllowance = async (): Promise<ControlAllowance | undefined> => {
    if (!config.controlAllowanceAsset) return undefined;
    const data = await handle.keymaster.resolveAsset(config.controlAllowanceAsset).catch(() => null);
    const chain = Array.isArray(data) ? (data as SignedRuleset[]) : [];
    if (chain.length === 0) return undefined;
    const head = await activeRuleset(handle, chain, { expectedSigner: config.parentDid }).catch(() => null);
    return head?.capabilities.control;
  };

  // Within-allowance predicate: an act whose required tier is standing/agent is WITHIN self-authority; a
  // 'parent'-band act is ABOVE it (escalate). Deny-by-default falls out of `tierForControlAct` (no match ⇒ HUMAN).
  const permit = async (ctx: ApprovalContext): Promise<boolean> => {
    const act = ctx.action ?? { action: 'unknown', resource: '' };
    const tier = tierForControlAct(act, await resolveAllowance());
    return bandForTier(tier) !== 'parent';
  };
  // Above-allowance escalation: route the act to the human PARENT's Signet (proof-of-human on approval, null on
  // decline/timeout — fail-closed). The same `hearthold/kb-approval-request` door the parent's handler answers.
  const escalate = async (ctx: ApprovalContext): Promise<HumanPresenceAssertion | null> => {
    const act = ctx.action ?? { action: 'unknown', resource: '' };
    const tier = tierForControlAct(act, await resolveAllowance());
    const approverDid = approverForTier(tier, topology);
    // Standing band — no Signet to route to (proof-of-agent). Not reached for an above-allowance act (always
    // the parent band), but keeps the handler total.
    if (!approverDid) return { method: 'agent', level: 1, timestamp: new Date().toISOString() };
    const timeout = tier >= AuthzTier.HUMAN ? config.stepUpTimeoutMs.factor2 : config.stepUpTimeoutMs.factor1;
    const ok = await requestActionApprovalOverDidComm(
      transport,
      approverDid,
      { action: act.action, resource: act.resource ?? '', summary: ctx.action?.summary ?? '' },
      timeout,
    );
    return ok ? { method: 'pin', level: tier >= AuthzTier.MULTIFACTOR ? 2 : 1, timestamp: new Date().toISOString() } : null;
  };

  const allowance = await resolveAllowance();
  return {
    gate: new AgentGate(onDecision, permit, escalate),
    isChild: true,
    bound: !!allowance?.selfApprove?.length,
    allowance,
    topology,
  };
}
