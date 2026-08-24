/**
 * e2e: AGENT-FAMILY SPEND / RISK ESCALATION — the two-tier Signet topology (flaxscrip decision 2026-07-08).
 *
 * An AI-agent Sovereign self-authorizes priced actions at its OWN Signet within a parent-signed allowance;
 * above the allowance (or above its sensitivity scope) the action escalates to the human PARENT's Signet.
 * It reuses the four AuthzTiers as approver-targets: STANDING (agent just acts) → CHALLENGE (agent Signet)
 * → HUMAN / MULTIFACTOR (parent Signet). The allowance is `capabilities.spend`, SIGNED by the parent into
 * the agent's Ruleset; governor-pinning means the agent cannot widen its own limit.
 *
 *   Part A — live signatures + governor-pinning, deterministic routing (a recording stub Signet):
 *            the full matrix — standing / agent-notify / agent-gate / parent / multifactor / sensitivity
 *            axis / self-raise rejected / fail-closed.
 *   Part B — a REAL DIDComm round-trip proves a step-up actually reaches the right Signet on the wire.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-agent-spend.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  DidCommTransport,
  Sensitivity,
  AuthzTier,
  signRuleset,
  rulesetId,
  type Ruleset,
  type SignedRuleset,
  type SpendAllowance,
  type FamilyTopology,
} from '@hearthold/core';
import { authorizeSpend, type SpendReceipt } from '@hearthold/warden/spend';
import { makeDidcommActionApprover, type KbActionApprover } from '@hearthold/warden/kb';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

/** A stub Signet that records which DID each step-up was routed to and returns a scripted verdict. */
function recordingApprover(verdict: boolean): { approver: KbActionApprover; targets: string[] } {
  const targets: string[] = [];
  return {
    approver: { async requestActionApproval(req) { targets.push(req.member); return verdict; } },
    targets,
  };
}

const AT = new Date('2026-07-08T12:00:00.000Z').toISOString();

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-agent-spend-e2e';
  const root = `${base.dataRoot}-agent-spend`;
  const parent = await openKeymaster('sovereign', { ...base, dataRoot: `${root}/parent` }, pass); // the human parent (governor)
  const agent = await openKeymaster('sovereign', { ...base, dataRoot: `${root}/agent` }, pass); // an AI-agent Sovereign
  const warden = await openKeymaster('warden', { ...base, dataRoot: `${root}/warden` }, pass); // custodian/enforcer
  const parentId = await ensureIdentity(parent, { ...base, dataRoot: `${root}/parent` });
  const agentId = await ensureIdentity(agent, { ...base, dataRoot: `${root}/agent` });
  await ensureIdentity(warden, { ...base, dataRoot: `${root}/warden` });
  const topology: FamilyTopology = { agentDid: agentId.did, parentDid: parentId.did };

  // The PARENT signs the agent's allowance (USD cents): under $1 routine; ≤ $50 the agent self-authorizes;
  // over $50 → parent; over $500 → parent + 2nd factor.
  const allowance: SpendAllowance = { unit: 'USD_cents', notifyAbove: 100, selfLimit: 5000, parentMultifactorAbove: 50000 };
  const rbase: Omit<Ruleset, 'version' | 'previous' | 'status' | 'capabilities' | 'ceiling'> = { actor: agentId.did, actorKind: 'agent' };
  const v1 = await signRuleset(parent, {
    ...rbase, version: 1, previous: null,
    capabilities: { kinds: ['activity', 'document'], verbs: ['read', 'propose', 'send'], spend: allowance },
    ceiling: Sensitivity.MEDIUM, status: 'active',
  });
  const chain: SignedRuleset[] = [v1];

  const req = (cost: number, extra?: Partial<{ sensitivity: Sensitivity }>) => ({
    action: 'lightning-pay', resource: 'invoice:demo', summary: `pay ${cost} ${allowance.unit}`, cost, ...extra,
  });

  step('Part A · STANDING — a sub-$1 action: the agent just acts (no Signet touched)');
  {
    const s = recordingApprover(false);
    const d = await authorizeSpend(warden, { chain, topology, request: req(50), approver: s.approver, at: AT });
    check('$0.50 is allowed within standing authority', d.allowed && d.band === 'standing' && d.tier === AuthzTier.STANDING);
    check('no Signet was contacted (routine)', s.targets.length === 0 && d.receipt.approver === 'standing');
  }

  step('Part A · AGENT band, notify mode — $25 self-authorized, a receipt goes to the parent (autonomy kept)');
  {
    const s = recordingApprover(false); // verdict irrelevant; notify never asks
    const receipts: SpendReceipt[] = [];
    const d = await authorizeSpend(warden, { chain, topology, request: req(2500), approver: s.approver, agentTierMode: 'notify', onReceipt: (r) => { receipts.push(r); }, at: AT });
    check('$25 is allowed in the agent band', d.allowed && d.band === 'agent' && d.tier === AuthzTier.CHALLENGE);
    check('notify mode did NOT block on a Signet (auto-approved)', s.targets.length === 0 && d.receipt.approver === 'self-notify');
    check('a receipt was emitted for the parent’s observation feed', receipts.length === 1 && receipts[0]?.approved === true && receipts[0]?.amount === 2500 && receipts[0]?.paid === false);
  }

  step('Part A · AGENT band, gate mode — $25 routes to the AGENT’s own Signet (not the parent’s)');
  {
    const approve = recordingApprover(true);
    const dOk = await authorizeSpend(warden, { chain, topology, request: req(2500), approver: approve.approver, agentTierMode: 'gate', at: AT });
    check('the step-up was routed to the AGENT’s Signet', approve.targets.length === 1 && approve.targets[0] === agentId.did);
    check('agent approves → allowed', dOk.allowed && dOk.receipt.approver === agentId.did);
    const decline = recordingApprover(false);
    const dNo = await authorizeSpend(warden, { chain, topology, request: req(2500), approver: decline.approver, agentTierMode: 'gate', at: AT });
    check('agent declines → denied (not silently allowed)', !dNo.allowed && dNo.receipt.approved === false);
  }

  step('Part A · PARENT band — $200 escalates to the human parent’s Signet, always a hard gate');
  {
    const approve = recordingApprover(true);
    const dOk = await authorizeSpend(warden, { chain, topology, request: req(20000), approver: approve.approver, agentTierMode: 'notify', at: AT });
    check('$200 is the parent band regardless of notify mode', dOk.band === 'parent' && dOk.tier === AuthzTier.HUMAN);
    check('the step-up was routed to the PARENT’s Signet', approve.targets.length === 1 && approve.targets[0] === parentId.did);
    check('parent approves → allowed', dOk.allowed && dOk.receipt.approver === parentId.did);
    const decline = recordingApprover(false);
    const dNo = await authorizeSpend(warden, { chain, topology, request: req(20000), approver: decline.approver, at: AT });
    check('parent declines / unreachable → denied (fail closed)', !dNo.allowed);
  }

  step('Part A · MULTIFACTOR tail — $1000 demands the parent’s 2nd factor');
  {
    const s = recordingApprover(true);
    const d = await authorizeSpend(warden, { chain, topology, request: req(100000), approver: s.approver, at: AT });
    check('$1000 lands at MULTIFACTOR, still the parent Signet', d.tier === AuthzTier.MULTIFACTOR && d.band === 'parent' && s.targets[0] === parentId.did);
  }

  step('Part A · SENSITIVITY axis — a cheap-but-HIGH action still reaches the parent');
  {
    const s = recordingApprover(true);
    const d = await authorizeSpend(warden, { chain, topology, request: req(0, { sensitivity: Sensitivity.HIGH }), approver: s.approver, at: AT });
    check('$0 + HIGH sensitivity → parent band (cost isn’t the only axis)', d.band === 'parent' && s.targets[0] === parentId.did);
    const s2 = recordingApprover(true);
    const d2 = await authorizeSpend(warden, { chain, topology, request: req(0, { sensitivity: Sensitivity.MEDIUM }), approver: s2.approver, agentTierMode: 'gate', at: AT });
    check('$0 + MEDIUM sensitivity → agent band (the agent handles its own medium work)', d2.band === 'agent' && s2.targets[0] === agentId.did);
  }

  step('Part A · the agent CANNOT raise its own limit — a self-signed v2 is rejected (governor-pinning)');
  {
    // The agent tries to sign a v2 lifting its own selfLimit to $10,000.
    const forged = await signRuleset(agent, {
      ...rbase, version: 2, previous: rulesetId(v1),
      capabilities: { kinds: ['activity', 'document'], verbs: ['read', 'propose', 'send'], spend: { ...allowance, selfLimit: 1000000 } },
      ceiling: Sensitivity.MEDIUM, status: 'active',
    });
    const s = recordingApprover(true);
    // $200 would be agent-band IF the forged raise took effect; under the parent-pinned operative (v1) it is parent-band.
    const d = await authorizeSpend(warden, { chain: [v1, forged], topology, request: req(20000), approver: s.approver, at: AT });
    check('the self-signed raise has NO effect — $200 still routes to the PARENT', d.band === 'parent' && s.targets[0] === parentId.did);
  }

  step('Part A · fail-closed — no active allowance ⇒ any priced action escalates to the parent');
  {
    const s = recordingApprover(true);
    const d = await authorizeSpend(warden, { chain: [], topology, request: req(50), approver: s.approver, at: AT });
    check('$0.50 with NO Ruleset escalates to the parent (no silent self-authority)', d.band === 'parent' && s.targets[0] === parentId.did);
  }

  step('Part B · LIVE DIDComm — a step-up actually reaches the right Signet on the wire');
  {
    const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, base.nodeUrl);
    await wardenTransport.ready();
    await new DidCommTransport(agent, IDENTITY_NAME.sovereign, base.nodeUrl).ready();
    await new DidCommTransport(parent, IDENTITY_NAME.sovereign, base.nodeUrl).ready();
    const liveApprover = makeDidcommActionApprover(wardenTransport, 30_000);
    const PIN = '2468';

    // Agent-band ($25, gate): the AGENT’s Signet answers.
    const agentSig = new DidCommTransport(agent, IDENTITY_NAME.sovereign, base.nodeUrl);
    const stopAgent = await agentSig.serve(makeSovereignHandler(agent, new PinGate(PIN, PIN)), { pollMs: 1000 });
    const dAgent = await authorizeSpend(warden, { chain, topology, request: req(2500), approver: liveApprover, agentTierMode: 'gate', at: AT });
    stopAgent();
    check('a $25 gate reaches the AGENT’s Signet over DIDComm → approved', dAgent.allowed && dAgent.receipt.approver === agentId.did);

    // Parent-band ($200): the PARENT’s Signet answers.
    const parentSig = new DidCommTransport(parent, IDENTITY_NAME.sovereign, base.nodeUrl);
    const stopParent = await parentSig.serve(makeSovereignHandler(parent, new PinGate(PIN, PIN)), { pollMs: 1000 });
    const dParent = await authorizeSpend(warden, { chain, topology, request: req(20000), approver: liveApprover, at: AT });
    stopParent();
    check('a $200 action reaches the PARENT’s Signet over DIDComm → approved', dParent.allowed && dParent.receipt.approver === parentId.did);
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ agent-spend: parent-signed allowance; agent self-authorizes in-band; over-limit/over-sensitivity escalate to the parent; the agent can’t raise its own limit; fail-closed; live over DIDComm\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-agent-spend: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
