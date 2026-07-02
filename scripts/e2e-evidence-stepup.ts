/**
 * e2e: the evidence step-up (milestone A2).
 *
 * A MEDIUM claim can't be minted at STANDING — the Warden demands a step-up. The Sovereign issues a
 * signed HearthholdApproval (carrying a proof-of-human assertion, as the Signet would), the Warden
 * verifies it binds to this exact disclosure + meets the PoH bar, and mints the evidence graph with
 * an `approval` block. Also checks the negative paths (too-low PoH, wrong evidence root).
 *
 * Isolated data root; run:  npm run e2e:evidence-stepup
 */
import { createHash } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  acceptCredential,
  requestProof,
  presentProof,
  verifyProof,
  issueEvidenceApproval,
  Sensitivity,
  PROTOCOL_VERSION,
  type EvidenceRequest,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-stepup';

  const warden = await openKeymaster('warden', config, pass);
  const witness = await openKeymaster('witness', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);

  const delSchema = await ensureDelegationSchema(warden);
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const delCred = await issueDelegation(warden, witnessId.did, delSchema, {
    kinds: ['location'],
    validUntil: oneYear,
  });
  await new DelegationStore(warden).record(witnessId.did, delCred);

  // Seed MEDIUM 'location' observations.
  const store = new VaultStore(warden.dataFolder);
  for (const [i, day] of ['2026-02-04', '2026-03-11', '2026-04-20', '2026-05-30'].entries()) {
    await store.put({
      id: hex(`loc-${i}`),
      kind: 'location',
      observedAt: `${day}T09:00:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.MEDIUM,
      ciphertext: '(sealed)',
      metadata: { witness: witnessId.did },
    });
  }
  process.stdout.write('seeded 4 MEDIUM location artefacts\n');

  const evidence = new EvidenceService(warden, { ...config, sovereignDid: sovId.did });
  const delegationValid = await new DelegationStore(warden).isAuthorized(witnessId.did);
  const baseReq: EvidenceRequest = {
    type: 'hearthold/evidence-request',
    version: PROTOCOL_VERSION,
    claim: 'Resided in FR during 2026-H1',
    disclosureMode: 'ATTESTATION',
    spec: { kind: 'location', from: '2026-01-01', to: '2026-06-30', structured: { type: 'residence', country: 'FR', period: '2026-H1' } },
  };

  process.stdout.write('\n▸ First request (no step-up) → the Warden demands one\n');
  const first = await evidence.handle(baseReq, witnessId.did, delegationValid);
  assert(first.status === 'step-up-required', 'MEDIUM claim returns step-up-required');
  if (first.status !== 'step-up-required' || !first.context) throw new Error('no step-up context');
  const ctx = first.context;
  assert(ctx.requiredLevel === 1, 'required proof-of-human level = 1 for MEDIUM');

  process.stdout.write('\n▸ Negative: an under-level approval is rejected\n');
  const weakApproval = await issueEvidenceApproval(sovereign, {
    wardenDid: wardenId.did,
    txn: ctx.txn,
    claim: ctx.claim,
    evidenceRoot: ctx.evidenceRoot,
    humanProof: { method: 'none', level: 0, timestamp: new Date().toISOString() },
  });
  const weak = await evidence.handle({ ...baseReq, stepUp: { method: 'challenge', value: weakApproval } }, witnessId.did, delegationValid);
  assert(weak.status === 'denied', 'level-0 approval → denied');

  process.stdout.write('\n▸ Negative: an approval for a different evidence set is rejected\n');
  const wrongRoot = await issueEvidenceApproval(sovereign, {
    wardenDid: wardenId.did,
    txn: ctx.txn,
    claim: ctx.claim,
    evidenceRoot: hex('some-other-root'),
    humanProof: { method: 'pin', level: 1, timestamp: new Date().toISOString() },
  });
  const wrong = await evidence.handle({ ...baseReq, stepUp: { method: 'challenge', value: wrongRoot } }, witnessId.did, delegationValid);
  assert(wrong.status === 'denied', 'wrong-evidence-root approval → denied');

  process.stdout.write('\n▸ Sovereign approves (proof-of-human, level 1) → the Warden mints with an approval block\n');
  const approval = await issueEvidenceApproval(sovereign, {
    wardenDid: wardenId.did,
    txn: ctx.txn,
    claim: ctx.claim,
    evidenceRoot: ctx.evidenceRoot,
    humanProof: { method: 'pin', level: 1, timestamp: new Date().toISOString() },
  });
  const granted = await evidence.handle({ ...baseReq, stepUp: { method: 'challenge', value: approval } }, witnessId.did, delegationValid);
  assert(granted.status === 'granted', 'valid approval → granted');
  if (granted.status !== 'granted') throw new Error('not granted');

  await acceptCredential(sovereign, granted.credentialDid);
  const challenge = await requestProof(verifier, { schema: granted.schemaDid, trustedIssuers: [wardenId.did] });
  const presentation = await presentProof(sovereign, challenge);
  const result = await verifyProof(verifier, presentation, { trustedIssuers: [wardenId.did], schema: granted.schemaDid });
  assert(result.ok, 'verifier verifies the evidence graph (issuer = Warden)');

  const claims = result.disclosed[0]?.claims ?? {};
  const appr = claims.approval as { approver?: string; humanProof?: { level?: number } } | undefined;
  assert(!!appr, 'approval block is present in the presented graph');
  assert(appr?.approver === sovId.did, 'approval approver = the Sovereign');
  assert(appr?.humanProof?.level === 1, 'approval carries proof-of-human level 1');

  process.stdout.write('\n✓ A2 step-up: sensitive claim → Sovereign co-sign (PoH) → minted with approval → verified\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-evidence-stepup: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
