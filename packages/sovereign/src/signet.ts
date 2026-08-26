/**
 * The Signet — the first proof-of-human gate.
 *
 * Presenting a proof *is* the external disclosure, so the Sovereign must approve it. The Signet is
 * the seam where proof-of-human is checked: an `ApprovalGate` is shown what is about to be
 * disclosed and to whom, and returns a `HumanPresenceAssertion` only if a fresh human approves.
 *
 * This first cut ships a PIN method (assurance level 1). Stronger methods — biometric, camera
 * face-liveness — are additional providers behind the same interface (see docs/sovereign-signet.md),
 * and the gate is where the proof-of-human level scales with sensitivity.
 */

import { randomUUID } from 'node:crypto';

import { dischargeDigest, type HumanPresenceAssertion, type SpendApprovalDetail, type KeymasterHandle, type Discharge, type DischargeRequest } from '@hearthold/core';
import type { PendingApproval, ApprovalHistoryEntry } from '@hearthold/control-types';

export interface ApprovalContext {
  /** The party the disclosure would go to (a verifier, or the Warden for an evidence approval). */
  requester: string;
  /** The challenge being answered (what is disclosed) — for a proof-request. */
  challengeDid?: string;
  /** The requested schema, if the verifier named one — shown as disclosure context. */
  schema?: string;
  /** For an evidence approval: the Warden-authored disclosure the Sovereign is asked to co-sign. */
  disclosure?: {
    claim: string;
    evidenceRoot: string;
    requiredLevel: number;
    reason: string;
  };
  /** For a KB assurance step-up (factor 2): the action the member is asked to authorize out-of-band. */
  action?: {
    action: string;
    resource: string;
    summary: string;
  };
  /**
   * For an agent-family SPEND escalation: the amount/agent/band the Signet renders as a spend decision
   * (docs/agent-family.md). Accompanies `action` (which carries the purpose) when a priced step-up escalates.
   */
  spend?: SpendApprovalDetail;
  /** For Ruleset governance: the policy change the Sovereign is asked to sign. */
  governance?: {
    summary: string;
  };
  /** For a guardianship acknowledgment: the SUBJECT member co-signs an edge granting a governor read over
   *  their OWN private data. Distinct from `governance` (the governor's own signing) — this is the watched
   *  member consenting to be watched (the amendment rule's member half). */
  guardianship?: {
    summary: string;
  };
  /** For a partition-key rewrap: the member unlocks their own private notes for a session. */
  rewrap?: {
    sessionId: string;
    partitionCount: number;
  };
}

export interface ApprovalGate {
  /** Approve a disclosure: return a human-presence assertion, or null to deny. */
  approve(ctx: ApprovalContext): Promise<HumanPresenceAssertion | null>;
}

/**
 * The control-plane surface `sovereign control` drives (a superset of `ApprovalGate`): the HUMAN path (`HttpGate`)
 * parks each act as a pending approval a GUI resolves with the PIN; the AGENT path (`AgentGate`) self-approves
 * synchronously, so nothing ever pends. Both expose the same shape so the daemon can run either gate.
 */
export interface SignetGate extends ApprovalGate {
  emit: (type: string, data: unknown) => void;
  listPending(): PendingApproval[];
  listHistory(): ApprovalHistoryEntry[];
  pendingCount(): number;
  decide(id: string, approve: boolean, pin?: string): { decision: 'approved' | 'denied' };
}

/**
 * A proof-of-human assertion from the PIN method, at the assurance level the disclosure REQUIRED. The level
 * is the Warden's server-set `requiredLevel` (from the drawn-on evidence's max sensitivity — never client-
 * asserted), floored at 1: a fresh human (device possession + PIN) approving a level-N disclosure, on top of
 * the member's already-proven session, clears level N. This is the same call the card-face fix (`5712cd1`)
 * made — session factor-1 + Signet proof-of-human factor-2 reaches up to MULTIFACTOR — applied here so a
 * SEALED (level-2) evidence forge is *approvable* instead of flat-denied ("level 1 below required 2"). The
 * gate is the designated place for the level to scale with sensitivity (see this file's docstring);
 * intrinsically-stronger methods (biometric / liveness) will later back the higher levels on their own.
 */
const pinAssertion = (level = 1): HumanPresenceAssertion => ({
  method: 'pin',
  level: Math.max(1, level),
  timestamp: new Date().toISOString(),
});

/** The assurance level an approval attests: the disclosure's server-set requiredLevel, else the base PIN level. */
const approvedLevel = (ctx: ApprovalContext): number => ctx.disclosure?.requiredLevel ?? 1;

/**
 * Non-interactive PIN gate — approves iff the supplied PIN matches the expected one. Used in tests
 * and headless flows (the human "entered" `supplied`).
 */
export class PinGate implements ApprovalGate {
  constructor(
    private readonly expected: string,
    private readonly supplied: string,
  ) {}

  async approve(ctx: ApprovalContext): Promise<HumanPresenceAssertion | null> {
    if (this.expected.length > 0 && this.supplied === this.expected) return pinAssertion(approvedLevel(ctx));
    return null;
  }
}

/** Always denies — a safe default when no Signet PIN is configured. */
export class DenyGate implements ApprovalGate {
  async approve(): Promise<HumanPresenceAssertion | null> {
    return null;
  }
}

/**
 * The AGENT's Signet gate — the third member of an AI-agent Sovereign's trinity (Emissary · Warden · Signet).
 *
 * An AI agent has no proof-of-human, so its Signet is not a PIN gate: it **self-approves within the agent's
 * parent-signed allowance** and emits a receipt (proof-of-AGENT, the "notify" mode). Above-scope acts never
 * reach this gate — the Warden's escalation ladder (`warden/escalate.ts`) routes those to the PARENT's Signet
 * — so anything that DOES arrive here is within the agent's authority and is authorized autonomously, with a
 * record. Preserves PVM: the parent signs the allowance (the law), the agent's Signet approves within it (the
 * conscience), the Warden custodies + enforces. See docs/agent-family.md.
 *
 * `onDecision` is the receipt hook — the parent's observation feed / an audit log (evidence pointed inward).
 * An optional `permit` predicate decides whether an act is WITHIN the agent's parent-signed allowance:
 * within ⇒ the agent self-approves (proof-of-AGENT). An optional `escalate` handler is invoked when an act
 * is ABOVE the allowance — it routes to the human PARENT's Signet and returns a proof-of-HUMAN assertion if
 * the parent approved, else null. With `escalate` UNSET, an above-allowance act is DENIED (fail-closed);
 * with BOTH unset the gate self-approves everything (the ROOT agent — it IS the root of authority).
 */
export class AgentGate implements SignetGate {
  /** Wired to the control server's `emit` (a receipt feed) when this gate backs `sovereign control`. */
  emit: (type: string, data: unknown) => void = () => {};
  private readonly history: ApprovalHistoryEntry[] = [];

  constructor(
    private readonly onDecision?: (ctx: ApprovalContext, approved: boolean) => void | Promise<void>,
    private readonly permit?: (ctx: ApprovalContext) => boolean | Promise<boolean>,
    private readonly escalate?: (ctx: ApprovalContext) => Promise<HumanPresenceAssertion | null>,
  ) {}

  async approve(ctx: ApprovalContext): Promise<HumanPresenceAssertion | null> {
    // Within the parent-signed allowance? No `permit` ⇒ within (the ROOT agent, or a plain self-approver).
    const within = this.permit ? await this.permit(ctx) : true;
    let assertion: HumanPresenceAssertion | null;
    if (within) {
      // Proof-of-AGENT: the agent's own key deliberately co-signs a within-scope act. Method names it as an
      // agent assertion (not human presence); level 1 is the agent's standing authority.
      assertion = { method: 'agent', level: 1, timestamp: new Date().toISOString() };
    } else if (this.escalate) {
      // Above the allowance — route to the human PARENT's Signet. Proof-of-HUMAN on approval, else null.
      assertion = await this.escalate(ctx);
    } else {
      // Above the allowance with no escalation path — deny (fail-closed). This is the deny-by-default posture
      // when a child agent has no allowance bound and no parent to escalate to.
      assertion = null;
    }
    const approved = assertion !== null;
    await this.onDecision?.(ctx, approved);
    const entry: ApprovalHistoryEntry = {
      id: randomUUID(),
      requester: ctx.requester,
      decision: approved ? 'approved' : 'denied',
      method: assertion?.method ?? 'agent',
      level: assertion?.level ?? 1,
      at: new Date().toISOString(),
    };
    this.history.push(entry);
    // `agent:` records HONESTLY whether this was a self-approval (proof-of-agent) or a parent proof-of-human.
    this.emit(approved ? 'approval-approved' : 'approval-denied', { id: entry.id, decision: entry.decision, agent: within });
    return assertion;
  }

  // Control-plane surface: an AgentGate self-approves synchronously, so nothing ever pends.
  listPending(): PendingApproval[] {
    return [];
  }
  pendingCount(): number {
    return 0;
  }
  listHistory(): ApprovalHistoryEntry[] {
    return [...this.history].reverse().slice(0, 50);
  }
  decide(): { decision: 'approved' | 'denied' } {
    throw new Error('this Signet runs in AGENT mode — it self-approves within the parent-signed allowance; there is nothing to decide');
  }
}

/** Interactive gate — shows the request on the terminal and reads the Signet PIN from stdin. */
export class PromptGate implements ApprovalGate {
  constructor(private readonly expected: string) {}

  async approve(ctx: ApprovalContext): Promise<HumanPresenceAssertion | null> {
    const detail = ctx.spend
      ? `   agent:     ${ctx.spend.agentDid.slice(0, 40)}…\n   spend:     ${ctx.spend.amount}${ctx.spend.unit ? ` ${ctx.spend.unit}` : ''}\n` +
        `   purpose:   ${ctx.action?.summary ?? ctx.action?.resource ?? '(unnamed)'}\n` +
        `   band:      ${ctx.spend.band}${ctx.spend.tier >= 4 ? ' · 2nd factor' : ''}\n`
      : ctx.disclosure
        ? `   claim:     ${ctx.disclosure.claim}\n   reason:    ${ctx.disclosure.reason}\n`
        : ctx.governance
          ? `   sign law:  ${ctx.governance.summary}\n`
          : ctx.action
            ? `   action:    ${ctx.action.action} on ${ctx.action.resource}\n   detail:    ${ctx.action.summary}\n`
            : `   challenge: ${(ctx.challengeDid ?? '').slice(0, 40)}…\n`;
    process.stdout.write(
      `\n🔑 Signet — a disclosure needs your approval\n` +
        `   from:      ${ctx.requester.slice(0, 40)}…\n` +
        detail +
        `   Enter Signet PIN to approve (blank to deny): `,
    );
    const pin = await readLine();
    if (pin.length > 0 && this.expected.length > 0 && pin === this.expected) {
      process.stdout.write('   ✓ approved.\n');
      return pinAssertion(approvedLevel(ctx));
    }
    process.stdout.write('   ✗ denied.\n');
    return null;
  }
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', (d: Buffer) => {
      process.stdin.pause();
      resolve(d.toString().trim());
    });
  });
}

/**
 * Produce a consent DISCHARGE for a third-party caveat: the designated party's Signet runs its proof-of-human
 * gate over the Warden-authored request and, on approval, SIGNS a discharge bound to the act's `txn` (the
 * macaroon holder-of-key proof). Returns null if the human declines. The signer (`idName`) must be `req.by`.
 */
export async function signDischarge(
  handle: KeymasterHandle,
  idName: string,
  gate: ApprovalGate,
  req: DischargeRequest,
): Promise<Discharge | null> {
  const assertion = await gate.approve({
    requester: 'the Warden',
    disclosure: {
      claim: req.claim,
      evidenceRoot: '',
      requiredLevel: req.sensitivity >= 2 ? 2 : 1,
      // Surface WHO receives the data and at what tier — the two most decision-relevant facts (audit-4 §5).
      reason: `${req.reason ?? `co-sign ${req.predicate}`} — recipient ${req.audience}, sensitivity ${req.sensitivity}`,
    },
  });
  if (!assertion) return null;
  // Bind the discharge to the exact disclosure the human just saw (claim/kind/owner/audience/sensitivity), so
  // it cannot be transplanted onto a different act under the same txn (audit-4 §1). Signed OVER the digest.
  const digest = dischargeDigest({
    txn: req.txn,
    predicate: req.predicate,
    claim: req.claim,
    kind: req.kind,
    owner: req.owner,
    audience: req.audience,
    sensitivity: req.sensitivity,
    ...(Array.isArray(req.reveal) ? { reveal: req.reveal } : {}),
  });
  await handle.keymaster.setCurrentId(idName);
  return (await handle.keymaster.addProof(
    { by: req.by, txn: req.txn, predicate: req.predicate, digest, level: assertion.level },
    idName,
  )) as Discharge;
}
