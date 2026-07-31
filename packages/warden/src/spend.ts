/**
 * Agent-family SPEND enforcement — the Warden ties the pure escalation ladder (`core/escalation.ts`) to
 * real Signets over DIDComm.
 *
 * The agent's parent-signed allowance rides in its Ruleset chain (`capabilities.spend`). We resolve the
 * OPERATIVE allowance under governor-pinning (`activeRuleset` with `expectedSigner = parentDid`), so a
 * self-signed raise by the agent is rejected and the operative allowance stays the parent's — the agent
 * can spend within its allowance but can never widen it. From that allowance + the action's cost and
 * sensitivity, `decideEscalation` yields the band and the Signet to route to:
 *
 *   standing  the agent just acts — no step-up, a receipt for the record
 *   agent     the agent's OWN Signet: `notify` (auto-approve + receipt to the parent's feed) or `gate`
 *   parent    the human PARENT's Signet — always a hard gate, never auto-approved
 *
 * Fail-closed: an absent, revoked, tampered, or wrong-signer chain yields no allowance, so any priced
 * action escalates to the parent. The agent silently loses self-authority; it never silently gains it.
 */

import {
  AuthzTier,
  Sensitivity,
  decideEscalation,
  activeRuleset,
  type SpendAllowance,
  type FamilyTopology,
  type EscalationBand,
  type SignedRuleset,
  type KeymasterHandle,
} from '@hearthold/core';

import type { KbActionApprover } from './kb.js';

/** How the agent band behaves — the tuning dial on top of the topology (docs/agent-family.md). */
export type AgentTierMode =
  /** Auto-approve within the allowance and emit a receipt (the "notify" lands on the parent's feed). */
  | 'notify'
  /** Require the agent's own Signet to deliberately approve each action in-band. */
  | 'gate';

export interface SpendRequest {
  /** The action verb for the approval prompt / receipt (e.g. `'lightning-pay'`). */
  action: string;
  /** A resource label — payee, invoice id, endpoint — for the prompt / receipt. */
  resource?: string;
  /** The one-line summary the Signet renders to the human/agent. */
  summary: string;
  /** Cost in the household's canonical minor unit (e.g. USD cents / sats). */
  cost: number;
  /** Sensitivity the action touches, if any. Defaults to PUBLIC (cost is the only axis). */
  sensitivity?: Sensitivity;
}

/** An audit record of a spend decision — emitted for allowed AND denied outcomes (evidence pointed inward). */
export interface SpendReceipt {
  action: string;
  resource?: string;
  cost: number;
  unit?: string;
  tier: AuthzTier;
  band: EscalationBand;
  approved: boolean;
  /** Who answered: a Signet DID, or `'standing'` / `'self-notify'` for the non-gated bands. */
  approver: string;
  at: string;
}

export interface SpendDecision {
  allowed: boolean;
  band: EscalationBand;
  tier: AuthzTier;
  reason: string;
  receipt: SpendReceipt;
}

export interface AuthorizeSpendOptions {
  /** The AGENT's own Ruleset chain (its `capabilities.spend` is the allowance; parent-signed). */
  chain: SignedRuleset[];
  /** The agent's own Signet DID and the human parent's Signet DID. */
  topology: FamilyTopology;
  /** The priced action. */
  request: SpendRequest;
  /** Routes a step-up to a chosen Signet over DIDComm (`makeDidcommActionApprover`). */
  approver: KbActionApprover;
  /** Agent-band behaviour. Default `'notify'` (autonomy-preserving; the receipt is the notification). */
  agentTierMode?: AgentTierMode;
  /** Called for every resolved decision (allowed or denied) — audit log / the parent's observation feed. */
  onReceipt?: (receipt: SpendReceipt) => void | Promise<void>;
  /** ISO clock for the receipt. Defaults to now. */
  at?: string;
}

/**
 * Authorize (or escalate, or deny) a priced action for an AI-agent Sovereign under its parent. Returns the
 * decision plus a receipt; `onReceipt` fires for both allowed and denied outcomes so the parent always has
 * a record even when auto-approval kept the human out of the loop.
 */
export async function authorizeSpend(
  warden: KeymasterHandle,
  opts: AuthorizeSpendOptions,
): Promise<SpendDecision> {
  const { chain, topology, request, approver } = opts;
  const at = opts.at ?? new Date().toISOString();
  const mode: AgentTierMode = opts.agentTierMode ?? 'notify';

  // Operative allowance under governor-pinning: only a chain the PARENT signed grants self-authority. An
  // absent/invalid/agent-signed chain ⇒ no allowance ⇒ every priced action escalates to the parent.
  const head = await activeRuleset(warden, chain, { expectedSigner: topology.parentDid }).catch(() => null);
  const allowance: SpendAllowance | undefined = head?.capabilities.spend;

  const decision = decideEscalation({
    sensitivity: request.sensitivity ?? Sensitivity.PUBLIC,
    cost: request.cost,
    allowance,
    topology,
  });

  const baseReceipt = {
    action: request.action,
    ...(request.resource !== undefined ? { resource: request.resource } : {}),
    cost: request.cost,
    ...(allowance?.unit !== undefined ? { unit: allowance.unit } : {}),
    tier: decision.tier,
    band: decision.band,
    at,
  };

  const finish = async (allowed: boolean, approver: string, reason: string): Promise<SpendDecision> => {
    const receipt: SpendReceipt = { ...baseReceipt, approved: allowed, approver };
    await opts.onReceipt?.(receipt);
    return { allowed, band: decision.band, tier: decision.tier, reason, receipt };
  };

  // Standing band — routine; the agent just acts. The receipt is the only trace.
  if (decision.band === 'standing') {
    return finish(true, 'standing', decision.reason);
  }

  // Agent band — the agent's own Signet. `notify` keeps it autonomous (auto-approve + receipt); `gate`
  // makes it a deliberate self-approval.
  if (decision.band === 'agent') {
    if (mode === 'notify') {
      return finish(true, 'self-notify', 'agent band, notify mode — self-authorized within allowance; receipt to the parent');
    }
    const ok = await approver.requestActionApproval({
      member: topology.agentDid,
      action: request.action,
      resource: request.resource ?? '',
      summary: request.summary,
    });
    return finish(ok, ok ? topology.agentDid : 'self-declined', ok ? 'agent self-approved at its own Signet' : 'agent declined at its own Signet');
  }

  // Parent band — the human's Signet. ALWAYS a hard gate; never auto-approved regardless of mode.
  const ok = await approver.requestActionApproval({
    member: topology.parentDid,
    action: request.action,
    resource: request.resource ?? '',
    summary: request.summary,
  });
  return finish(ok, ok ? topology.parentDid : 'parent-declined', ok ? "the parent approved at their Signet" : 'the parent declined (or the Signet was unreachable) — fail closed');
}
