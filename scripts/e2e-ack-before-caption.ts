/**
 * e2e: ACK-BEFORE-CAPTION — a submission is ack'd immediately ("received & queued"); the slow caption/classify
 * runs in the background, so a vision model can't cause a false reply-wait timeout (Aegis).
 *
 *   - the ack returns FAST (well before a deliberately-slow captioner finishes) with `queued:true` + the
 *     deterministic artefactId;
 *   - the artefact still lands born-obsidian (quarantined) AFTER processing, and `onStored` fires then with
 *     the real, post-classification receipt (the seam for the submission-stored SSE);
 *   - kind-enforcement + auth still gate SYNCHRONOUSLY (a refused submission gets a deny, not a fake ack).
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-ack-before-caption.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  sealForWarden,
  Sensitivity,
  PROTOCOL_VERSION,
  type WitnessSubmission,
  type SubmissionReceipt,
} from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { VaultStore } from '@hearthold/warden/store';
import { DelegationStore } from '@hearthold/warden/delegations';
import { makeWardenHandler } from '@hearthold/warden/handler';
import type { Classifier } from '@hearthold/warden/classifier';
import type { VisionCaptioner } from '@hearthold/warden/vision';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const CAPTION_DELAY = 1200; // a deliberately-slow vision model
const stubClassifier: Classifier = { async classify() { return { sensitivity: Sensitivity.MEDIUM, metadata: {}, needsHumanConfirmation: false }; } };
const stubEmbedder = { async embed(_t: string): Promise<number[]> { return [1, 0]; } };
const slowCaptioner: VisionCaptioner = { async caption() { await new Promise((r) => setTimeout(r, CAPTION_DELAY)); return { description: 'a slow-captioned image', tags: ['slow'] }; } };

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-ack-e2e';
  const config = { ...base, dataRoot: `${base.dataRoot}-ack-before-caption` };
  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const wid = await ensureIdentity(warden, config);
  const eid = await ensureIdentity(emissary, config);
  const delegations = new DelegationStore(warden);
  const store = new VaultStore(warden.dataFolder);
  const svc = new WardenService(warden, stubClassifier, stubEmbedder, slowCaptioner);

  const schema = await ensureDelegationSchema(warden);
  const cred = await issueDelegation(warden, eid.did, schema, { kinds: ['image'], validUntil: new Date(Date.now() + 1e10).toISOString() });
  await delegations.record(eid.did, cred, undefined, ['image']);

  const storedEvents: SubmissionReceipt[] = [];
  const handler = makeWardenHandler(
    svc, delegations, undefined, undefined, wid.did,
    { confirmAtOrBelow: Sensitivity.SEALED, isAutofileTrusted: async () => false },
    (receipt) => storedEvents.push(receipt),
  );

  const imageSubmission = async (): Promise<WitnessSubmission> => ({
    type: 'hearthold/witness-submission', version: PROTOCOL_VERSION, kind: 'image', observedAt: new Date('2026-07-31').toISOString(),
    ciphertext: await sealForWarden(warden, wid.did, JSON.stringify({ image: { mediaType: 'image/png', bytesB64: 'ZmFrZQ==' } })),
  });

  step('the ack returns IMMEDIATELY — before the slow caption finishes');
  const sub = await imageSubmission();
  const t0 = Date.now();
  const ack = (await handler(sub, eid.did)) as SubmissionReceipt;
  const ackMs = Date.now() - t0;
  check('the reply is a submission receipt', ack?.type === 'hearthold/submission-receipt');
  check('the ack is queued (received & queued, no sensitivity yet)', ack?.queued === true && ack?.assignedSensitivity === undefined);
  check('the ack carries the deterministic artefactId', ack?.artefactId === svc.artefactIdFor(sub));
  check(`the ack was FAST — ${ackMs}ms, well under the ${CAPTION_DELAY}ms caption`, ackMs < CAPTION_DELAY / 2);
  check('at ack time the artefact is NOT yet stored (still captioning)', (await store.get(ack.artefactId)) === undefined);

  step('the background processing lands the artefact born-obsidian + fires onStored');
  let stored = await store.get(ack.artefactId);
  for (let i = 0; i < 40 && !stored; i++) { await new Promise((r) => setTimeout(r, 100)); stored = await store.get(ack.artefactId); }
  check('the artefact is stored after the background caption/classify', !!stored);
  check('quarantined born-obsidian (an image is a proposal → the Sovereign admits)', stored?.metadata?.needsHumanConfirmation === true);
  check('the caption was applied (background vision ran)', stored?.metadata?.description === 'a slow-captioned image');
  check('onStored fired with the real receipt (the submission-stored SSE seam)', storedEvents.length === 1 && storedEvents[0]?.artefactId === ack.artefactId && storedEvents[0]?.assignedSensitivity === Sensitivity.MEDIUM);

  step('auth + kind still gate SYNCHRONOUSLY — a wrong-kind submission is refused, not fake-ack’d');
  const docSub: WitnessSubmission = { type: 'hearthold/witness-submission', version: PROTOCOL_VERSION, kind: 'document', observedAt: new Date('2026-07-31').toISOString(), ciphertext: await sealForWarden(warden, wid.did, JSON.stringify({ text: 'x' })) };
  const denied = await handler(docSub, eid.did); // this Emissary is image-only
  check('a non-delegated kind is refused (deny, not a queued ack)', denied?.type === 'hearthold/error');

  process.stdout.write(
    failures === 0
      ? '\n✓ ack-before-caption: fast queued ack; caption/classify async; born-obsidian lands after; auth/kind gate synchronously\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-ack-before-caption: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
