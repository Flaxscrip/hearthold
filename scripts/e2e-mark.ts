/**
 * e2e: Warden-issued SevenfoldMark (retires the P0 demo-issuer caveat).
 *
 * The Sovereign claims a Mark; the Warden RE-COUNTS the vault (never trusting a client count) and issues
 * an axes-free SevenfoldMark VC only when the threshold is met. Below threshold → not issued. The issued
 * Mark verifies on-node and carries no `axes` claim.
 *
 * Live (needs the Archon node). Run:  npm run e2e:mark   (classifier forced to quarantine)
 */
import { loadConfig, openKeymaster, ensureIdentity, sealForWarden, acceptCredential, PROTOCOL_VERSION, type WitnessSubmission } from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { claimableMarks, claimMark } from '@hearthold/warden/marks';
import type { MarkCandidate } from '@hearthold/control-types';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const warden = await openKeymaster('warden', config, 'hearthold-e2e-mark');
  const sovereign = await openKeymaster('sovereign', config, 'hearthold-e2e-mark');
  const wid = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const service = new WardenService(warden);

  const candidate: MarkCandidate = { markName: 'Librarian I', spec: { kind: 'document' }, threshold: 5 };

  const submitDoc = async (n: number): Promise<void> => {
    const ciphertext = await sealForWarden(warden, wid.did, JSON.stringify({ text: `book ${n}` }));
    const submission: WitnessSubmission = { type: 'hearthold/witness-submission', version: PROTOCOL_VERSION, kind: 'document', observedAt: new Date('2026-07-08').toISOString(), ciphertext };
    await service.handleSubmission(submission, wid.did);
  };

  process.stdout.write('▸ Below threshold → not claimable, claim refused\n');
  for (let i = 0; i < 3; i++) await submitDoc(i);
  const s0 = (await claimableMarks(warden, [candidate]))[0]!;
  assert(s0.count === 3 && !s0.claimable, 'Librarian I shows 3/5 — not yet claimable');
  const early = await claimMark(warden, { candidate, subjectDid: sovId.did });
  assert(!early.issued && early.count === 3, 'claiming below threshold does not issue (Warden re-counts)');

  process.stdout.write('\n▸ Cross the threshold → claimable → Warden issues\n');
  for (let i = 3; i < 6; i++) await submitDoc(i); // now 6 documents
  const s1 = (await claimableMarks(warden, [candidate]))[0]!;
  assert(s1.count === 6 && s1.claimable, 'Librarian I is now claimable (6 ≥ 5)');
  const claimed = await claimMark(warden, { candidate, subjectDid: sovId.did });
  assert(claimed.issued === true, 'the Warden issues the Mark');
  if (!claimed.issued) throw new Error('unreachable');
  assert(claimed.credentialDid.startsWith('did:'), 'the Mark is a real credential DID');

  process.stdout.write('\n▸ The Mark verifies on-node and is axes-free\n');
  await acceptCredential(sovereign, claimed.credentialDid);
  const vc = (await sovereign.keymaster.getCredential(claimed.credentialDid)) as { credentialSubject?: Record<string, unknown> } | null;
  const subj = vc?.credentialSubject ?? {};
  assert((subj.type as string) === 'SevenfoldMark' && (subj.mark as string) === 'Librarian I', 'the credential is a SevenfoldMark named Librarian I');
  assert(!('axes' in subj), 'the Mark carries NO axes claim (axes-free until the PrivacyMage pact)');

  process.stdout.write('\n✓ SevenfoldMark: explicit claim → Warden re-counts + issues → verifiable, axes-free\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-mark: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
