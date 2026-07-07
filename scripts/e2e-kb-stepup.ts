/**
 * e2e: registry-governed assurance step-up (factor 2) for the KB.
 *
 * The Trust Registry declares, per action, the required assurance (`read → factor1`, `write → factor2`).
 * A web-login session is factor1. When policy demands factor2, the Warden asks the member out-of-band to
 * authorize the action (here an in-process approver double stands in for the direct Warden→Signet
 * channel). Proves: writes step up and are gated by the approval; reads don't step up; deny blocks;
 * and the policy (not code) governs — a factor1 write policy takes no step-up.
 *
 * Live (needs the Archon node + Ollama). Run:  npm run e2e:kb-stepup
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  createAssurancePolicy,
  grantAuthorization,
  GroupTrustRegistry,
  LedgerAssurancePolicy,
  PROTOCOL_VERSION,
  type KbSessionRequestMessage,
} from '@hearthold/core';
import { KbService, type KbActionApprover } from '@hearthold/warden/kb';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-kb-stepup';
  const kbId = 'guild-kb-stepup';

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);

  const readGroup = await createRegistryGroup(warden, `kb-read-${kbId}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${kbId}`, config.registry);
  await grantAuthorization(warden, readGroup, aliceId.did);
  await grantAuthorization(warden, writeGroup, aliceId.did);

  // Governance policy: writes require factor2, reads factor1.
  const policyAsset = await createAssurancePolicy(warden, { read: 'factor1', write: 'factor2' }, config.registry);
  const bindings = [
    { action: 'read', resource: kbId, group: readGroup },
    { action: 'write', resource: kbId, group: writeGroup },
  ];
  const registry = new GroupTrustRegistry(warden, bindings, wardenId.did, new LedgerAssurancePolicy(warden, policyAsset));

  // Approver double stands in for the direct Warden→Signet channel; records calls, returns `verdict`.
  const calls: { action: string; summary: string }[] = [];
  let verdict = true;
  const approver: KbActionApprover = {
    async requestActionApproval(req) {
      calls.push({ action: req.action, summary: req.summary });
      return verdict;
    },
  };
  const kb = new KbService(warden, config, { kbId, wardenDid: wardenId.did, registry, approver });
  process.stdout.write(`KB "${kbId}": Alice granted; policy write→factor2, read→factor1\n`);

  // Alice logs in (challenge/response → factor1 session).
  const challenge = await kb.startLogin(kbId, 'https://mage.example/cb');
  const responseDID = await alice.keymaster.createResponse(challenge);
  const session = await kb.completeLogin(responseDID);
  if (session.type !== 'hearthold/kb-session') throw new Error(`login failed: ${JSON.stringify(session)}`);
  const token = session.token;
  const sreq = (body: Partial<KbSessionRequestMessage>): KbSessionRequestMessage => ({
    type: 'hearthold/kb-session-request',
    version: PROTOCOL_VERSION,
    token,
    kbId,
    action: 'query',
    ...body,
  });

  process.stdout.write('\n▸ Write requires factor2 → steps up → member approves\n');
  verdict = true;
  calls.length = 0;
  const upd = await kb.serveWithSession(sreq({ action: 'update', kind: 'event', text: 'Guild elections close Friday August 8.' }));
  assert(upd.type === 'hearthold/kb-result' && upd.action === 'update', 'the write succeeds after approval');
  assert(calls.length === 1 && calls[0]?.action === 'write', 'the Sovereign was asked to authorize the write (step-up fired once)');

  process.stdout.write('\n▸ Read is factor1 → no step-up\n');
  calls.length = 0;
  const q = await kb.serveWithSession(sreq({ action: 'query', query: 'When do guild elections close?' }));
  assert(q.type === 'hearthold/kb-result' && q.action === 'query', 'the read succeeds');
  assert(calls.length === 0, 'reads do NOT trigger a step-up (factor1 suffices)');

  process.stdout.write('\n▸ Write with the member declining → refused\n');
  verdict = false;
  calls.length = 0;
  const denied = await kb.serveWithSession(sreq({ action: 'update', kind: 'event', text: 'unauthorized edit' }));
  assert(denied.type === 'hearthold/kb-error', 'a declined step-up blocks the write');
  assert(calls.length === 1, 'the step-up was asked before being declined');

  process.stdout.write('\n▸ Policy (not code) governs: a factor1 write policy takes no step-up\n');
  const policy1 = await createAssurancePolicy(warden, { read: 'factor1', write: 'factor1' }, config.registry);
  const kb1 = new KbService(warden, config, {
    kbId,
    wardenDid: wardenId.did,
    registry: new GroupTrustRegistry(warden, bindings, wardenId.did, new LedgerAssurancePolicy(warden, policy1)),
    approver,
  });
  const c2 = await kb1.startLogin(kbId, 'https://mage.example/cb');
  const r2 = await alice.keymaster.createResponse(c2);
  const s2 = await kb1.completeLogin(r2);
  if (s2.type !== 'hearthold/kb-session') throw new Error('login2 failed');
  calls.length = 0;
  verdict = false; // would decline — but should never be asked
  const upd2 = await kb1.serveWithSession({ type: 'hearthold/kb-session-request', version: PROTOCOL_VERSION, token: s2.token, kbId, action: 'update', kind: 'event', text: 'Low-stakes note.' });
  assert(upd2.type === 'hearthold/kb-result' && upd2.action === 'update', 'the write succeeds with no step-up');
  assert(calls.length === 0, 'no approval was requested — the policy said factor1');

  process.stdout.write('\n✓ Registry-governed step-up: policy sets the tier, the Warden enforces, the Sovereign authorizes out-of-band\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-stepup: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
