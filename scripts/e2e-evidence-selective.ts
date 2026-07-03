/**
 * e2e: selective disclosure (milestone A3).
 *
 * The witnessed group commits to salted per-observation Merkle leaves. On request the Warden reveals
 * a chosen subset — each as `{kind, observedAt, salt, path}` — verifiable against the graph's signed
 * root. A verifier can spot-check one supporting observation without seeing the others; tampering or
 * fabricating a leaf fails.
 *
 * Isolated data root; run:  npm run e2e:evidence-selective
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
  verifyRevealedLeaf,
  Sensitivity,
  PROTOCOL_VERSION,
  type RevealedLeaf,
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
  const pass = 'hearthold-e2e-selective';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const witness = await openKeymaster('witness', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);
  const witnessId = await ensureIdentity(witness, config);

  const delSchema = await ensureDelegationSchema(warden);
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const delCred = await issueDelegation(warden, witnessId.did, delSchema, { kinds: ['location'], validUntil: oneYear });
  await new DelegationStore(warden).record(witnessId.did, delCred);

  // Four PUBLIC location observations (PUBLIC → STANDING clears, no co-sign needed here).
  const store = new VaultStore(warden.dataFolder);
  const days = ['2026-02-04', '2026-03-11', '2026-04-20', '2026-05-30'];
  for (const [i, d] of days.entries()) {
    await store.put({
      id: hex(`loc-${i}`),
      kind: 'location',
      observedAt: `${d}T09:00:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.PUBLIC,
      ciphertext: '(sealed)',
      metadata: { witness: witnessId.did },
    });
  }

  // Prove, revealing ONLY observation #1 (the 2026-03-11 ping).
  const evidence = new EvidenceService(warden, { ...config, sovereignDid: sovId.did });
  const delegationValid = await new DelegationStore(warden).isAuthorized(witnessId.did);
  const req: EvidenceRequest = {
    type: 'hearthold/evidence-request',
    version: PROTOCOL_VERSION,
    claim: 'Visited these places in 2026-H1',
    disclosureMode: 'SELECTIVE',
    spec: { kind: 'location', from: '2026-01-01', to: '2026-06-30' },
    subjectDid: sovId.did,
    reveal: [1],
  };
  const granted = await evidence.handle(req, witnessId.did, delegationValid);
  if (granted.status !== 'granted') throw new Error(`not granted: ${JSON.stringify(granted)}`);
  await acceptCredential(sovereign, granted.credentialDid);

  const challenge = await requestProof(verifier, { schema: granted.schemaDid, trustedIssuers: [wardenId.did] });
  const presentation = await presentProof(sovereign, challenge);
  const result = await verifyProof(verifier, presentation, { trustedIssuers: [wardenId.did], schema: granted.schemaDid });
  assert(result.ok, 'verifier verifies the evidence graph');

  const claims = result.disclosed[0]?.claims ?? {};
  const group = ((claims.evidence as unknown[] | undefined) ?? [])[0] as {
    count?: number;
    disclosure?: string;
    commitment?: { merkleRoot?: string };
    revealed?: RevealedLeaf[];
  };
  const root = group.commitment?.merkleRoot ?? '';
  const revealed = group.revealed ?? [];

  assert(group.count === 4, 'the group still commits to all 4 observations');
  assert(group.disclosure === 'selective', 'disclosure mode is selective');
  assert(revealed.length === 1, 'exactly ONE observation is revealed (the rest stay hidden)');
  const leaf = revealed[0] as RevealedLeaf;
  assert(leaf.observedAt === '2026-03-11T09:00:00Z', 'the revealed observation is the requested 2026-03-11 one');
  assert(verifyRevealedLeaf(leaf, root), 'the revealed leaf verifies against the signed Merkle root');
  assert(!verifyRevealedLeaf({ ...leaf, observedAt: '2026-12-25T09:00:00Z' }, root), 'tampering the date breaks membership');
  assert(!verifyRevealedLeaf({ ...leaf, salt: hex('fake') }, root), 'a wrong salt breaks membership');

  process.stdout.write('\n✓ A3 selective disclosure: reveal one supporting fact, prove it, hide the rest\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-evidence-selective: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
