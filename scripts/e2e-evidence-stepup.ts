/**
 * e2e: the Sovereign co-signature (milestone A2, signed-approval form).
 *
 * The Sovereign signs the approval statement with its own key (`addProof`); the Warden verifies that
 * detached signature and embeds it in the evidence graph. Proves: valid approval verifies; the
 * negatives (under-level PoH, wrong evidence root, unsigned, wrong signer) are rejected; and the
 * embedded approval is **third-party verifiable** (a verifier confirms the Sovereign's signature and
 * detects tampering) — no decryption needed.
 *
 * Isolated data root; run:  npm run e2e:evidence-stepup
 */
import { createHash } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  assembleEvidence,
  signEvidenceApproval,
  verifyEvidenceApproval,
  mintEvidenceGraph,
  requestProof,
  presentProof,
  verifyProof,
  acceptCredential,
  Sensitivity,
  type ArtefactMeta,
  type EvidenceApprovalStatement,
} from '@hearthold/core';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-stepup';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const witness = await openKeymaster('witness', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);
  const witnessId = await ensureIdentity(witness, config);

  const metas: ArtefactMeta[] = ['2026-02-04', '2026-03-11', '2026-04-20'].map((d, i) => ({
    id: hex(`loc-${i}`),
    kind: 'location',
    observedAt: `${d}T09:00:00Z`,
    sensitivity: Sensitivity.MEDIUM,
    witnessedBy: witnessId.did,
  }));
  const assembled = assembleEvidence(metas, { kind: 'location' });
  if (!assembled) throw new Error('no evidence assembled');
  const evidenceRoot = assembled.group.commitment.merkleRoot;
  const claim = 'Resided in FR during 2026-H1';
  const stmt = (level: number, root = evidenceRoot): EvidenceApprovalStatement => ({
    approver: sovId.did,
    txn: 'tx-1',
    claim,
    evidenceRoot: root,
    humanProof: { method: 'pin', level, timestamp: new Date().toISOString() },
  });
  const expect = { approver: sovId.did, claim, evidenceRoot, requiredLevel: 1 };

  process.stdout.write('\n▸ The Sovereign signs; the Warden verifies\n');
  const good = await signEvidenceApproval(sovereign, stmt(1));
  assert((await verifyEvidenceApproval(warden, good, expect)).ok, 'valid signed approval verifies');

  process.stdout.write('\n▸ Negatives are rejected\n');
  assert(!(await verifyEvidenceApproval(warden, await signEvidenceApproval(sovereign, stmt(0)), expect)).ok, 'level-0 proof-of-human → rejected');
  assert(!(await verifyEvidenceApproval(warden, await signEvidenceApproval(sovereign, stmt(1, hex('other'))), expect)).ok, 'wrong evidence root → rejected');
  assert(!(await verifyEvidenceApproval(warden, { ...stmt(1) }, expect)).ok, 'unsigned statement → rejected');
  const wrongSigner = await signEvidenceApproval(witness, { ...stmt(1), approver: witnessId.did });
  assert(!(await verifyEvidenceApproval(warden, wrongSigner, expect)).ok, 'signed by the wrong party → rejected');

  process.stdout.write('\n▸ Mint with the signed approval, then verify + third-party-check the co-sign\n');
  const { credentialDid, schemaDid } = await mintEvidenceGraph(warden, {
    subjectDid: sovId.did,
    claim,
    evidence: [assembled.group],
    txn: 'tx-1',
    validUntil: new Date(Date.now() + 1000 * 60 * 10).toISOString(),
    approval: good,
  });
  await acceptCredential(sovereign, credentialDid);
  const challenge = await requestProof(verifier, { schema: schemaDid, trustedIssuers: [wardenId.did] });
  const presentation = await presentProof(sovereign, challenge);
  const result = await verifyProof(verifier, presentation, { trustedIssuers: [wardenId.did], schema: schemaDid });
  assert(result.ok, 'verifier verifies the evidence graph');

  const approval = (result.disclosed[0]?.claims ?? {}).approval as Record<string, unknown> | undefined;
  assert(!!approval?.proof, 'the embedded approval carries the Sovereign’s signature');
  const vp = verifier.keymaster.verifyProof.bind(verifier.keymaster) as (o: unknown) => Promise<boolean>;
  assert(await vp(approval), 'a third party (the verifier) verifies the Sovereign co-sign — no decryption');
  assert(!(await vp({ ...approval, claim: 'Resided in DE during 2026-H1' })), 'tampering with the approved claim breaks the signature');

  process.stdout.write('\n✓ A2 signed approval: Sovereign co-sign is embedded + independently verifiable\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-evidence-stepup: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
