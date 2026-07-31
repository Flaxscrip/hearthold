/**
 * Agent-family SPEND / RISK escalation — the cost axis on the authorization ladder.
 *
 * Hearthold's release ladder (`security.ts`) grades a request by its artefact SENSITIVITY. For a family
 * of AI-agent Sovereigns under a human "parent" (see docs/agent-family.md), a second axis matters just as
 * much: the COST or RISK of the action itself. An agent spending $2 and an agent spending $2,000 both
 * touch no sensitive artefact, yet only one should reach the human.
 *
 * The decision here is deliberately *not* a new ladder — it reuses the four `AuthzTier`s and reads their
 * names as APPROVER-TARGETS in the agent family:
 *
 *   STANDING     the agent just acts (routine, below the notify line)
 *   CHALLENGE    the AGENT's own Signet co-signs — a deliberate, receipted proof-of-AGENT within its scope
 *   HUMAN        the PARENT's Signet — proof-of-HUMAN; the tier is literally named for it
 *   MULTIFACTOR  the PARENT's Signet + a 2nd factor, for the highest-risk band
 *
 * The band an action lands in comes from a SpendAllowance the PARENT signs into the agent's Ruleset
 * (`RulesetCapabilities.spend`). The agent cannot widen its own allowance — the Ruleset chain is
 * governor-pinned to the parent, so a self-signed raise is rejected and the operative allowance stays the
 * parent's. Raising it is a parent-signed supersession = graduated autonomy. Absent allowance ⇒ no
 * self-authority for cost: any priced action escalates to the parent (deny-by-default).
 *
 * Pure / transport-free, like `security.ts` and `ruleset.ts`. The Warden ties this to real Signets in
 * `warden/spend.ts`.
 */

import { AuthzTier, Sensitivity, requiredTier } from './security.js';

/**
 * What an actor may SELF-authorize, and where it escalates — the parent-signed allowance. All amounts are
 * in ONE canonical minor unit per household (e.g. USD cents, or sats); `unit` is a display/audit label,
 * never used for comparison. Comparisons are on the raw integers so there is no float/rounding ambiguity
 * at a threshold boundary.
 */
export interface SpendAllowance {
  /**
   * The ceiling (inclusive) the actor may self-authorize at its OWN Signet (the CHALLENGE / agent band).
   * A cost above this escalates to the PARENT. `0` ⇒ the agent may self-authorize nothing priced.
   */
  selfLimit: number;
  /**
   * Cost strictly above this enters the agent band (a deliberate, receipted self-approval / notify). At or
   * below it the action is STANDING — the agent just acts, no step-up. Absent ⇒ `0`: any non-zero cost is
   * at least a notify. Must be ≤ `selfLimit`.
   */
  notifyAbove?: number;
  /**
   * Cost strictly above this reaches the parent's HIGHEST band (MULTIFACTOR — parent Signet + 2nd factor).
   * Absent ⇒ the parent band is HUMAN (single proof-of-human). Must be ≥ `selfLimit` when set.
   */
  parentMultifactorAbove?: number;
  /** Canonical unit label for display / audit (e.g. `'USD_cents'`, `'sats'`). Not used in comparisons. */
  unit?: string;
}

/** Which principal a tier's step-up routes to in the agent family. */
export type EscalationBand = 'standing' | 'agent' | 'parent';

/** The two Signets an escalation can route to: the acting agent's own, and the human parent's. */
export interface FamilyTopology {
  /** The AI agent's own Sovereign DID (its Signet answers the CHALLENGE / agent band). */
  agentDid: string;
  /** The human parent's Sovereign DID (its Signet answers the HUMAN / MULTIFACTOR band). */
  parentDid: string;
}

export interface EscalationDecision {
  /** The authorization tier the action requires (max of its sensitivity- and cost-derived tiers). */
  tier: AuthzTier;
  /** Which principal must approve: nobody (standing), the agent's own Signet, or the parent's. */
  band: EscalationBand;
  /** The Signet DID the step-up routes to, or undefined for the standing band. */
  approverDid?: string;
  /** Human-readable rationale (for logs / receipts, not the wire). */
  reason: string;
}

/**
 * The tier a COST alone demands, given the parent-signed allowance. No allowance ⇒ treat `selfLimit` as 0
 * (the agent may self-authorize nothing), so any non-zero cost lands in the parent band — deny-by-default.
 */
export function tierForCost(cost: number, allowance?: SpendAllowance): AuthzTier {
  if (!Number.isFinite(cost) || cost <= 0) return AuthzTier.STANDING;
  const selfLimit = Math.max(0, allowance?.selfLimit ?? 0);
  const notifyAbove = Math.max(0, allowance?.notifyAbove ?? 0);
  if (cost <= notifyAbove) return AuthzTier.STANDING; // below the notify line — routine
  if (cost <= selfLimit) return AuthzTier.CHALLENGE; // agent band — the agent's own Signet
  // Parent band. A configured multifactor line pushes the very-high-cost tail to the 2nd factor.
  const mfAbove = allowance?.parentMultifactorAbove;
  if (mfAbove !== undefined && cost > Math.max(mfAbove, selfLimit)) return AuthzTier.MULTIFACTOR;
  return AuthzTier.HUMAN;
}

/**
 * The combined required tier: the higher of what the artefact SENSITIVITY demands (the existing ladder)
 * and what the action COST demands. A cheap-but-SEALED action and an expensive-but-LOW action can both
 * reach the parent, for different reasons — which is the whole point.
 */
export function requiredTierWithCost(
  sensitivity: Sensitivity,
  cost: number,
  allowance?: SpendAllowance,
): AuthzTier {
  const bySensitivity = requiredTier(sensitivity);
  const byCost = tierForCost(cost, allowance);
  return (Math.max(bySensitivity, byCost) as AuthzTier);
}

/** Read a tier's name as an approver-target in the agent family. */
export function bandForTier(tier: AuthzTier): EscalationBand {
  if (tier <= AuthzTier.STANDING) return 'standing';
  if (tier === AuthzTier.CHALLENGE) return 'agent';
  return 'parent'; // HUMAN | MULTIFACTOR
}

/** The Signet DID a tier routes to (undefined for the standing band). */
export function approverForTier(tier: AuthzTier, topology: FamilyTopology): string | undefined {
  const band = bandForTier(tier);
  if (band === 'agent') return topology.agentDid;
  if (band === 'parent') return topology.parentDid;
  return undefined;
}

export interface EscalationInput {
  /** Sensitivity of any artefact the action touches. Defaults to PUBLIC (no sensitivity contribution). */
  sensitivity?: Sensitivity;
  /** Cost / risk-priced magnitude of the action in the household's canonical minor unit. Defaults to 0. */
  cost?: number;
  /** The parent-signed allowance from the agent's active Ruleset. Absent ⇒ no self-authority for cost. */
  allowance?: SpendAllowance;
  /** The agent's own and the parent's Signet DIDs. */
  topology: FamilyTopology;
}

/**
 * The one call a caller makes: given an action's sensitivity + cost, the agent's parent-signed allowance,
 * and the family's two Signets, decide the required tier and WHOSE Signet must approve. Pure — the Warden
 * (`warden/spend.ts`) turns the `approverDid` into a real DIDComm step-up.
 */
export function decideEscalation(input: EscalationInput): EscalationDecision {
  const sensitivity = input.sensitivity ?? Sensitivity.PUBLIC;
  const cost = input.cost ?? 0;
  const tier = requiredTierWithCost(sensitivity, cost, input.allowance);
  const band = bandForTier(tier);
  const approverDid = approverForTier(tier, input.topology);
  const reason =
    band === 'standing'
      ? 'within standing authority (routine sensitivity, cost at/below the notify line)'
      : band === 'agent'
        ? 'agent band — the agent self-authorizes at its own Signet (deliberate, receipted, within its parent-signed allowance)'
        : `parent band — escalates to the human parent's Signet (tier ${tier}: ${cost > (input.allowance?.selfLimit ?? 0) ? 'cost exceeds the self-limit' : 'sensitivity exceeds agent scope'})`;
  return { tier, band, approverDid, reason };
}
