/**
 * e2e: triage / born-obsidian confirmation queue.
 *
 * A quarantined submission (the classifier flagged needsHumanConfirmation) appears in the queue; the
 * Sovereign confirms it at a chosen sensitivity, which clears the flag and drops it from the queue.
 * Overriding *down* below the human-confirm threshold is permitted here because confirming IS the human
 * gesture the model requires.
 *
 * Live (needs the Archon node). Run:  npm run e2e:triage   (classifier forced to quarantine)
 */
import { loadConfig, openKeymaster, ensureIdentity, sealForWarden, PROTOCOL_VERSION, Sensitivity, type WitnessSubmission } from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { triageQueue, confirmTriage } from '@hearthold/warden/triage';
import { VaultStore } from '@hearthold/warden/store';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const warden = await openKeymaster('warden', config, 'hearthold-e2e-triage');
  const wid = await ensureIdentity(warden, config);
  // Quarantine classifier → every submission is SEALED + needsHumanConfirmation (fail-safe default).
  const service = new WardenService(warden);
  const emissaryDid = wid.did;

  const submit = async (kind: string, text: string): Promise<string> => {
    const ciphertext = await sealForWarden(warden, wid.did, JSON.stringify({ text }));
    const submission: WitnessSubmission = { type: 'hearthold/witness-submission', version: PROTOCOL_VERSION, kind: kind as never, observedAt: new Date('2026-07-08').toISOString(), ciphertext };
    const receipt = await service.handleSubmission(submission, emissaryDid);
    return receipt.artefactId;
  };

  const idA = await submit('document', 'a shelf photo of Dune');
  const idB = await submit('document', 'a shelf photo of Snow Crash');
  process.stdout.write('submitted 2 documents (quarantine classifier → both flagged)\n');

  process.stdout.write('\n▸ Both land in the triage queue (born obsidian)\n');
  const q0 = await triageQueue(warden);
  assert(q0.length === 2, 'the queue holds both quarantined artefacts');
  assert(q0.every((t) => t.proposedSensitivityName === 'SEALED'), 'the Scribe proposed SEALED (fail-safe default)');

  process.stdout.write('\n▸ Confirm A down to PUBLIC (the human gesture permits relaxing below the threshold)\n');
  const conf = await confirmTriage(warden, { artefactId: idA, sensitivity: Sensitivity.PUBLIC });
  assert(conf.proposedSensitivityName === 'PUBLIC', 'A is confirmed at PUBLIC');
  const stored = await new VaultStore(warden.dataFolder).get(idA);
  assert(stored?.sensitivity === Sensitivity.PUBLIC, 'the stored sensitivity is now PUBLIC');
  assert(stored?.metadata?.needsHumanConfirmation === false, 'the confirmation flag is cleared');
  assert(stored?.metadata?.confirmedBySovereign === true && stored?.metadata?.relaxedBelowThreshold === true, 'the human decision (and that it relaxed below threshold) is recorded');

  process.stdout.write('\n▸ The queue now holds only B\n');
  const q1 = await triageQueue(warden);
  assert(q1.length === 1 && q1[0]?.artefactId === idB, 'A left the queue; B remains');

  process.stdout.write('\n✓ Triage: quarantine queue → Sovereign confirms/adjusts → flag cleared, card reveals\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-triage: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
