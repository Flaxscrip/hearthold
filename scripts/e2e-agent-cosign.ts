/**
 * e2e: AGENT-FAMILY CO-SIGN ESCALATION — the trinity's Signet made real (the card-pass blocker, generalized).
 *
 * A disclosure co-sign now routes by TIER, like spend: STANDING self-clears; CHALLENGE goes to the AGENT's own
 * Signet (its AgentGate self-approves the within-scope act + receipts — proof-of-agent, no human PIN); HUMAN/MFA
 * escalates to the PARENT's Signet (the human authorizes the agent's above-scope disclosure). This is exactly
 * how a readable card pass reaches flaxscrip while a provenance pass clears at the agent.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-agent-cosign.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  DidCommTransport,
  AuthzTier,
  type FamilyTopology,
} from '@hearthold/core';
import { routeCoSign } from '@hearthold/warden/escalate';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { AgentGate, PinGate } from '@hearthold/sovereign/signet';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const PIN = '2468';
const TIMEOUTS = { factor1: 30_000, factor2: 30_000 };

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-agent-cosign-e2e';
  const root = `${base.dataRoot}-agent-cosign`;
  const parent = await openKeymaster('sovereign', { ...base, dataRoot: `${root}/parent` }, pass); // the human parent
  const agent = await openKeymaster('sovereign', { ...base, dataRoot: `${root}/agent` }, pass); // an AI-agent Sovereign
  const warden = await openKeymaster('warden', { ...base, dataRoot: `${root}/warden` }, pass); // the custodian/router
  const parentId = await ensureIdentity(parent, { ...base, dataRoot: `${root}/parent` });
  const agentId = await ensureIdentity(agent, { ...base, dataRoot: `${root}/agent` });
  await ensureIdentity(warden, { ...base, dataRoot: `${root}/warden` });
  const topology: FamilyTopology = { agentDid: agentId.did, parentDid: parentId.did };

  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, base.nodeUrl);
  await wardenTransport.ready();

  const req = (what: string) => ({ action: 'pass', resource: 'did:cid:card', summary: what });

  step('STANDING — within standing authority: no Signet is contacted');
  {
    const outcome = await routeCoSign(wardenTransport, topology, AuthzTier.STANDING, req('routine'), TIMEOUTS);
    check('a standing co-sign self-clears (band=standing, approved, no approver)', outcome.approved && outcome.band === 'standing' && outcome.approver === undefined);
  }

  step("CHALLENGE — the AGENT's own Signet self-approves a within-scope act (AgentGate, proof-of-agent + receipt)");
  {
    const receipts: { summary: string; approved: boolean }[] = [];
    const agentSig = new DidCommTransport(agent, IDENTITY_NAME.sovereign, base.nodeUrl);
    await agentSig.ready();
    const stop = await agentSig.serve(makeSovereignHandler(agent, new AgentGate((ctx, ok) => { receipts.push({ summary: ctx.action?.summary ?? '', approved: ok }); })), { pollMs: 1000 });
    const outcome = await routeCoSign(wardenTransport, topology, AuthzTier.CHALLENGE, req('a provenance-only card pass'), TIMEOUTS);
    stop();
    check('routes to the AGENT’s Signet and self-approves', outcome.approved && outcome.band === 'agent' && outcome.approver === agentId.did);
    check('the AgentGate emitted a receipt (evidence pointed inward)', receipts.length === 1 && receipts[0]?.approved === true);
  }

  step('CHALLENGE — an AgentGate whose policy REFUSES a within-scope act fails closed');
  {
    const agentSig = new DidCommTransport(agent, IDENTITY_NAME.sovereign, base.nodeUrl);
    await agentSig.ready();
    const stop = await agentSig.serve(makeSovereignHandler(agent, new AgentGate(undefined, () => false)), { pollMs: 1000 });
    const outcome = await routeCoSign(wardenTransport, topology, AuthzTier.CHALLENGE, req('a refused act'), TIMEOUTS);
    stop();
    check('a policy-refused within-scope act is denied (fail closed)', !outcome.approved && outcome.band === 'agent');
  }

  step("HUMAN — an above-scope disclosure escalates to the PARENT's Signet (the readable-card-pass path)");
  {
    const parentSig = new DidCommTransport(parent, IDENTITY_NAME.sovereign, base.nodeUrl);
    await parentSig.ready();
    const stopOk = await parentSig.serve(makeSovereignHandler(parent, new PinGate(PIN, PIN)), { pollMs: 1000 });
    const okOutcome = await routeCoSign(wardenTransport, topology, AuthzTier.HUMAN, req('Pass a READABLE card to Seven'), TIMEOUTS);
    stopOk();
    check('routes to the PARENT’s Signet; the human approves → allowed', okOutcome.approved && okOutcome.band === 'parent' && okOutcome.approver === parentId.did);

    const parentSig2 = new DidCommTransport(parent, IDENTITY_NAME.sovereign, base.nodeUrl);
    await parentSig2.ready();
    const stopNo = await parentSig2.serve(makeSovereignHandler(parent, new PinGate(PIN, 'wrong')), { pollMs: 1000 });
    const noOutcome = await routeCoSign(wardenTransport, topology, AuthzTier.HUMAN, req('Pass a READABLE card to Seven'), TIMEOUTS);
    stopNo();
    check('the parent declines → denied (fail closed, the disclosure halts)', !noOutcome.approved && noOutcome.band === 'parent');
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ agent-cosign: co-signs route by tier — standing self-clears, the agent Signet self-approves within scope, above-scope escalates to the parent; the trinity’s Signet is real\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-agent-cosign: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
