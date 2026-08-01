/**
 * Escalation-aware co-sign routing — the agent-family generalization of the spend ladder to ANY co-sign.
 *
 * A classic (human) Warden co-signs a disclosure at the acting member's own Signet. In the agent family the
 * member is an AI-agent Sovereign whose Signet self-authorizes only within its parent-signed allowance and
 * ESCALATES above that to the human parent's Signet. So a co-sign routes by TIER, exactly like `authorizeSpend`:
 *
 *   STANDING     no co-sign — within standing authority
 *   CHALLENGE    the AGENT's own Signet (its AgentGate self-approves the within-scope act + receipts)
 *   HUMAN | MFA  the PARENT's Signet (the human authorizes the agent's above-scope disclosure)
 *
 * This is the third member of the trinity made real: the Warden custodies + routes, the agent's Signet is the
 * within-scope conscience, the parent's Signet the above-scope one. Reuses core `approverForTier`.
 */

import { AuthzTier, approverForTier, type FamilyTopology, type Transport } from '@hearthold/core';

import { makeDidcommActionApprover } from './kb.js';

export interface CoSignRequest {
  action: string;
  resource: string;
  /** Warden-authored summary the answering Signet renders (never the requester's words). */
  summary: string;
}

export interface CoSignOutcome {
  approved: boolean;
  band: 'standing' | 'agent' | 'parent';
  /** The Signet DID that answered (undefined for the standing band). */
  approver?: string;
}

/**
 * Route a co-sign to the right Signet for `tier` and return the decision. STANDING is auto-approved (no
 * Signet contacted); CHALLENGE routes to the agent's own Signet; HUMAN/MULTIFACTOR to the parent's. A Signet
 * that declines or can't be reached ⇒ not approved (fail closed).
 */
export async function routeCoSign(
  transport: Transport,
  topology: FamilyTopology,
  tier: AuthzTier,
  req: CoSignRequest,
  timeouts: { factor1: number; factor2: number },
): Promise<CoSignOutcome> {
  const approverDid = approverForTier(tier, topology);
  if (!approverDid) return { approved: true, band: 'standing' }; // within standing authority — no co-sign

  const band = approverDid === topology.parentDid ? 'parent' : 'agent';
  const timeout = tier >= AuthzTier.HUMAN ? timeouts.factor2 : timeouts.factor1;
  const approved = await makeDidcommActionApprover(transport, timeout).requestActionApproval({ member: approverDid, ...req });
  return { approved, band, approver: approverDid };
}
