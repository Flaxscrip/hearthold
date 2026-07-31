/**
 * e2e: THE SIGNET ANSWERS A SPEND STEP-UP — the last piece for a live family roleplay (Aegis).
 *
 * `authorizeSpend`'s parent-band escalation already reaches the parent's Signet over DIDComm (proven in
 * e2e:agent-spend Part B). This proves the SIGNET SIDE surfaces it as a real SPEND decision and answers it
 * through the browser/daemon gate — the `HttpGate` the `sovereign control` daemon (:4311) uses:
 *
 *   Warden  authorizeSpend (parent band) → kb-approval-request(spend) → Signet
 *   Signet  HttpGate parks a `spend-approval` (agent · amount · unit · band) — what the Table renders
 *   human   POST /api/approve {pin}  → HttpGate.decide → proof-of-human → kb-approval-response
 *   Warden  authorizeSpend resolves allowed / denied
 *
 * The verdict is the HUMAN's (a correct PIN), not a stub — exactly what the roleplay needs.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-signet-spend.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  DidCommTransport,
  Sensitivity,
  signRuleset,
  type Ruleset,
  type SignedRuleset,
  type SpendAllowance,
  type FamilyTopology,
} from '@hearthold/core';
import { authorizeSpend } from '@hearthold/warden/spend';
import { makeDidcommActionApprover } from '@hearthold/warden/kb';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { HttpGate } from '@hearthold/sovereign/http-gate';
import type { PendingApproval } from '@hearthold/control-types';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PIN = '2468';
const AT = new Date('2026-08-01T12:00:00.000Z').toISOString();

/** Wait for the gate to park a spend-approval, then return it (or throw). */
async function waitForSpendPending(gate: HttpGate): Promise<PendingApproval> {
  for (let i = 0; i < 60; i++) {
    const p = gate.listPending().find((a) => a.kind === 'spend-approval');
    if (p) return p;
    await sleep(250);
  }
  throw new Error('no spend-approval parked within timeout');
}

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-signet-spend-e2e';
  const root = `${base.dataRoot}-signet-spend`;
  const parent = await openKeymaster('sovereign', { ...base, dataRoot: `${root}/parent` }, pass);
  const agent = await openKeymaster('sovereign', { ...base, dataRoot: `${root}/agent` }, pass);
  const warden = await openKeymaster('warden', { ...base, dataRoot: `${root}/warden` }, pass);
  const parentId = await ensureIdentity(parent, { ...base, dataRoot: `${root}/parent` });
  const agentId = await ensureIdentity(agent, { ...base, dataRoot: `${root}/agent` });
  await ensureIdentity(warden, { ...base, dataRoot: `${root}/warden` });
  const topology: FamilyTopology = { agentDid: agentId.did, parentDid: parentId.did };

  // The parent signs the agent's allowance (sats): ≤ $50-equiv self-limit; over → parent; over 50k → 2FA.
  const allowance: SpendAllowance = { unit: 'sat', notifyAbove: 100, selfLimit: 5000, parentMultifactorAbove: 50000 };
  const rbase: Omit<Ruleset, 'version' | 'previous' | 'status' | 'capabilities' | 'ceiling'> = { actor: agentId.did, actorKind: 'agent' };
  const v1 = await signRuleset(parent, {
    ...rbase, version: 1, previous: null,
    capabilities: { kinds: ['activity', 'document'], verbs: ['read', 'propose', 'send'], spend: allowance },
    ceiling: Sensitivity.MEDIUM, status: 'active',
  });
  const chain: SignedRuleset[] = [v1];

  // Transports: the Warden asks; each Signet serves its own mailbox with an HttpGate (the daemon's gate).
  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, base.nodeUrl);
  await wardenTransport.ready();
  const approver = makeDidcommActionApprover(wardenTransport, 30_000);

  const parentGate = new HttpGate(PIN, 60_000);
  const parentSig = new DidCommTransport(parent, IDENTITY_NAME.sovereign, base.nodeUrl);
  await parentSig.ready();
  const stopParent = await parentSig.serve(makeSovereignHandler(parent, parentGate), { pollMs: 1000 });

  const agentGate = new HttpGate(PIN, 60_000);
  const agentSig = new DidCommTransport(agent, IDENTITY_NAME.sovereign, base.nodeUrl);
  await agentSig.ready();
  const stopAgent = await agentSig.serve(makeSovereignHandler(agent, agentGate), { pollMs: 1000 });

  const req = (cost: number, extra?: Record<string, unknown>) => ({
    action: 'lightning-pay', resource: 'invoice:premium-data', summary: 'buy the premium data asset', cost, ...extra,
  });

  try {
    step('PARENT band — the Signet parks a spend-approval the human decides ($200 → parent)');
    {
      const pending = authorizeSpend(warden, { chain, topology, request: req(20000), approver, at: AT });
      const p = await waitForSpendPending(parentGate);
      check('the parked approval is a SPEND decision, not a generic yes/no', p.kind === 'spend-approval');
      check('it names the AGENT that is asking', p.agent === agentId.did);
      check('it carries the amount + unit (20000 sat)', p.amount === 20000 && p.unit === 'sat');
      check('it is marked the parent band', p.band === 'parent' && p.multifactor === false);
      check('it carries the purpose (Warden-authored summary)', typeof p.summary === 'string' && p.summary!.length > 0);
      const r = parentGate.decide(p.id, true, PIN); // the human approves with the correct PIN
      check('a correct-PIN decision resolves as approved', r.decision === 'approved');
      const d = await pending;
      check('authorizeSpend returns ALLOWED — the human said yes', d.allowed && d.receipt.approver === parentId.did);
    }

    step('THE HALT — the human declines at the Signet ($200 → parent → denied)');
    {
      const pending = authorizeSpend(warden, { chain, topology, request: req(20000), approver, at: AT });
      const p = await waitForSpendPending(parentGate);
      parentGate.decide(p.id, false); // deny
      const d = await pending;
      check('a declined spend is denied (fail closed, the settlement halts)', !d.allowed && d.receipt.approved === false);
    }

    step('MULTIFACTOR tail — a $1000 spend is flagged for the 2nd factor');
    {
      const pending = authorizeSpend(warden, { chain, topology, request: req(100000), approver, at: AT });
      const p = await waitForSpendPending(parentGate);
      check('the spend-approval is flagged multifactor (parent Signet + 2nd factor)', p.multifactor === true && p.amount === 100000);
      const wrong = (() => { try { parentGate.decide(p.id, true, '0000'); return 'approved'; } catch { return 'rejected'; } })();
      check('a wrong PIN is rejected and leaves it pending (retryable)', wrong === 'rejected');
      parentGate.decide(p.id, true, PIN);
      check('the correct PIN then approves', (await pending).allowed);
    }

    step('AGENT band — the same handler, the agent’s OWN Signet ($25, gate mode)');
    {
      const pending = authorizeSpend(warden, { chain, topology, request: req(2500), approver, agentTierMode: 'gate', at: AT });
      const p = await waitForSpendPending(agentGate);
      check('the agent-band spend parks at the AGENT’s Signet, marked the agent band', p.kind === 'spend-approval' && p.band === 'agent' && p.agent === agentId.did);
      agentGate.decide(p.id, true, PIN);
      check('the agent self-approves at its own Signet → allowed', (await pending).allowed);
    }
  } finally {
    stopParent();
    stopAgent();
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ signet-spend: the Signet renders a spend decision (agent · amount · band), PIN-gates it, and answers the step-up — the roleplay verdict is the human’s\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-signet-spend: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
