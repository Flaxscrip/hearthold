/**
 * e2e: financial selective disclosure (A3, financial theme).
 *
 * Financial variant of e2e-evidence-selective.ts. The witnessed group commits to salted
 * per-record Merkle leaves. An auditor spot-checks ONE quarter's income record against the
 * signed root while the other three stay hidden; tampering or a wrong salt fails.
 *
 * Isolated data root; run:  npm run e2e:finance-selective
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
  const pass = 'hearthold-finance-selective';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const witness = await openKeymaster('emissary', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);
  const witnessId = await ensureIdentity(witness, config);

  const delSchema = await ensureDelegationSchema(warden);
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const delCred = await issueDelegation(warden, witnessId.did, delSchema, { kinds: ['transaction'], validUntil: oneYear });
  await new DelegationStore(warden).record(witnessId.did, delCred);

  // Four quarterly income records (LOW → STANDING clears; figures live in the sealed ciphertext).
  const store = new VaultStore(warden.dataFolder);
  const quarters = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'];
  for (const [i, d] of quarters.entries()) {
    await store.put({
      id: hex(`income-q${i + 1}`),
      kind: 'transaction',
      observedAt: `${d}T00:00:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.LOW,
      ciphertext: '(sealed)',
      metadata: { witness: witnessId.did },
    });
  }

  // Prove, revealing ONLY record #1 (the 2025-06-30 quarter) as an auditor spot-check.
  const evidence = new EvidenceService(warden, { ...config, sovereignDid: sovId.did });
  const delegationValid = await new DelegationStore(warden).isAuthorized(witnessId.did);
  const req: EvidenceRequest = {
    type: 'hearthold/evidence-request',
    version: PROTOCOL_VERSION,
    claim: 'Received qualifying income in each quarter of 2025',
    disclosureMode: 'SELECTIVE',
    spec: { kind: 'transaction', from: '2025-01-01', to: '2026-01-01' },
    subjectDid: sovId.did,
    reveal: [1],
  };
  const granted = await evidence.handle(req, witnessId.did, delegationValid);
  if (granted.status !== 'granted') throw new Error(`not granted: ${JSON.stringify(granted)}`);
  await acceptCredential(sovereign, granted.credentialDid);

  const challenge = await requestProof(verifier, { schema: granted.schemaDid, trustedIssuers: [wardenId.did] });
  const presentation = await presentProof(sovereign, challenge);
  const result = await verifyProof(verifier, presentation, { trustedIssuers: [wardenId.did], schema: granted.schemaDid });
  assert(result.ok, 'auditor verifies the evidence graph');

  const claims = result.disclosed[0]?.claims ?? {};
  const group = ((claims.evidence as unknown[] | undefined) ?? [])[0] as {
    count?: number;
    disclosure?: string;
    commitment?: { merkleRoot?: string };
    revealed?: RevealedLeaf[];
  };
  const root = group.commitment?.merkleRoot ?? '';
  const revealed = group.revealed ?? [];

  assert(group.count === 4, 'the group still commits to all 4 quarterly records');
  assert(group.disclosure === 'selective', 'disclosure mode is selective');
  assert(revealed.length === 1, 'exactly ONE record is revealed (the other three stay hidden)');
  const leaf = revealed[0] as RevealedLeaf;
  assert(leaf.observedAt === '2025-06-30T00:00:00Z', 'the revealed record is the requested 2025-06-30 quarter');
  assert(verifyRevealedLeaf(leaf, root), 'the revealed leaf verifies against the signed Merkle root');
  assert(!verifyRevealedLeaf({ ...leaf, observedAt: '2025-12-25T00:00:00Z' }, root), 'tampering the date breaks membership');
  assert(!verifyRevealedLeaf({ ...leaf, salt: hex('fake') }, root), 'a wrong salt breaks membership');

  process.stdout.write('\n✓ Finance A3 selective disclosure: spot-check one record, prove it, hide the rest\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-finance-selective: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
