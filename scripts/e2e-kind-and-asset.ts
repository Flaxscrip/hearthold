/**
 * e2e: KIND-ENFORCEMENT (compartmentalized Emissaries) + NATIVE IMAGE-ASSET transport (Aegis).
 *
 *   A · kind-enforcement: the Warden refuses a submission whose kind isn't in the sender's delegated kinds
 *       (fail-closed) — so a text Emissary can't submit images, and vice versa. Legacy delegations (no
 *       recorded kinds) get the pre-image text set.
 *   B · image-asset transport: the Emissary stores bytes as a native Archon image asset (createImage → the
 *       node's IPFS) and ships the asset DID; the Warden getImage's it back → captions it. No base64 in DIDComm.
 *   C · source-scan of both wirings.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-kind-and-asset.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

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
} from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { VaultStore } from '@hearthold/warden/store';
import { DelegationStore } from '@hearthold/warden/delegations';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { OllamaVisionCaptioner } from '@hearthold/warden/vision';
import type { Classifier } from '@hearthold/warden/classifier';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const stubClassifier: Classifier = { async classify() { return { sensitivity: Sensitivity.MEDIUM, metadata: {}, needsHumanConfirmation: false }; } };
const stubEmbedder = { async embed(_t: string): Promise<number[]> { return [1, 0]; } };

function crc32(b: Buffer): number { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function pc(t: string, d: Buffer): Buffer { const T = Buffer.from(t, 'ascii'); const L = Buffer.alloc(4); L.writeUInt32BE(d.length, 0); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(Buffer.concat([T, d])), 0); return Buffer.concat([L, T, d, C]); }
function png(w: number, h: number, r: number, g: number, b: number): Buffer { const s = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2; const rows: Buffer[] = []; for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; } rows.push(row); } return Buffer.concat([s, pc('IHDR', ih), pc('IDAT', deflateSync(Buffer.concat(rows))), pc('IEND', Buffer.alloc(0))]); }

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-kind-asset-e2e';
  const config = { ...base, dataRoot: `${base.dataRoot}-kind-asset` };
  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const wid = await ensureIdentity(warden, config);
  const eid = await ensureIdentity(emissary, config);
  const delegations = new DelegationStore(warden);
  const store = new VaultStore(warden.dataFolder);
  const svc = new WardenService(warden, stubClassifier, stubEmbedder);
  const ingest = { confirmAtOrBelow: Sensitivity.SEALED, isAutofileTrusted: async () => false };
  const handler = makeWardenHandler(svc, delegations, undefined, undefined, wid.did, ingest);

  const sub = async (kind: string): Promise<WitnessSubmission> => ({
    type: 'hearthold/witness-submission', version: PROTOCOL_VERSION, kind: kind as never, observedAt: new Date('2026-07-30').toISOString(),
    ciphertext: await sealForWarden(warden, wid.did, JSON.stringify({ text: `a ${kind}` })),
  });

  step('A · kind-enforcement — a text-only delegation accepts document, REFUSES image (fail-closed)');
  const schema = await ensureDelegationSchema(warden);
  const validUntil = new Date(Date.now() + 1e10).toISOString();
  const cred = await issueDelegation(warden, eid.did, schema, { kinds: ['document'], validUntil });
  await delegations.record(eid.did, cred, undefined, ['document']);
  const okDoc = await handler(await sub('document'), eid.did);
  check('a delegated kind (document) is accepted', okDoc?.type === 'hearthold/submission-receipt');
  const denyImg = await handler(await sub('image'), eid.did);
  check('a NON-delegated kind (image) is refused', denyImg?.type === 'hearthold/error' && /not delegated for 'image'/.test((denyImg as { reason?: string }).reason ?? ''));

  step('A · a LEGACY delegation (no recorded kinds) → pre-image text set (document ok, image refused)');
  const em2 = await openKeymaster('verifier', config, pass); // stand-in for a second Emissary DID
  const e2 = await ensureIdentity(em2, config);
  const cred2 = await issueDelegation(warden, e2.did, schema, { kinds: ['document'], validUntil });
  await delegations.record(e2.did, cred2); // NO kinds → legacy
  check('legacy delegation accepts document', (await handler(await sub('document'), e2.did))?.type === 'hearthold/submission-receipt');
  check('legacy delegation REFUSES image (never granted by default)', (await handler(await sub('image'), e2.did))?.type === 'hearthold/error');

  step('B · native image asset — createImage → the node IPFS → getImage retrieves the exact bytes');
  const bytes = png(96, 96, 200, 30, 40);
  const assetDid = await warden.keymaster.createImage(bytes);
  check('createImage returns an asset DID', typeof assetDid === 'string' && assetDid.startsWith('did:'));
  const asset = await warden.keymaster.getImage(assetDid);
  check('getImage retrieves the bytes (data buffer) + dimensions', !!asset?.file?.data && asset.image?.width === 96 && asset.image?.height === 96);
  check('the retrieved bytes match what we stored', Buffer.from(asset!.file.data!).equals(bytes));

  const visionModel = base.visionModel;
  const tags = await fetch(`${base.ollamaUrl}/api/tags`).then((r) => r.json()).then((d: unknown) => (d as { models?: { name?: string }[] }).models?.map((m) => m.name ?? '') ?? []).catch(() => [] as string[]);
  if (!tags.some((n) => n.startsWith(visionModel))) {
    process.stdout.write(`  ⓘ caption skipped: no '${visionModel}' on ${base.ollamaUrl}\n`);
  } else {
    step('B · a submission carrying the asset DID (no base64) is captioned from IPFS + linked to the asset');
    const imgSvc = new WardenService(warden, stubClassifier, stubEmbedder, new OllamaVisionCaptioner(base.ollamaUrl, visionModel));
    const imgHandler = makeWardenHandler(imgSvc, delegations, undefined, undefined, wid.did, ingest);
    const imgCred = await issueDelegation(warden, eid.did, schema, { kinds: ['image'], validUntil });
    await delegations.record(eid.did, imgCred, undefined, ['image']); // re-scope this Emissary to image
    const ciphertext = await sealForWarden(warden, wid.did, JSON.stringify({ assetDid, mediaType: 'image/png' }));
    const receipt = await imgHandler({ type: 'hearthold/witness-submission', version: PROTOCOL_VERSION, kind: 'image', observedAt: new Date('2026-07-30').toISOString(), ciphertext }, eid.did);
    check('the image submission (asset DID only, no base64) is accepted + queued', receipt?.type === 'hearthold/submission-receipt');
    // Ack-before-caption: the caption/classify/store runs in the background — poll for the landed artefact.
    const artId = receipt?.type === 'hearthold/submission-receipt' ? (receipt as { artefactId: string }).artefactId : '';
    let art = await store.get(artId);
    for (let i = 0; i < 40 && !art; i++) { await new Promise((r) => setTimeout(r, 100)); art = await store.get(artId); }
    check('captioned from the IPFS-retrieved bytes (has a description)', typeof art?.metadata?.description === 'string' && (art!.metadata!.description as string).length > 0);
    check('the artefact links the native image asset DID', art?.metadata?.assetDid === assetDid);
    check('and inherits the ingestion gate (quarantined)', art?.metadata?.needsHumanConfirmation === true);
  }

  step('C · source-scan — the wiring holds');
  const root = dirname(fileURLToPath(import.meta.url));
  const handlerSrc = readFileSync(join(root, '..', 'packages/warden/src/handler.ts'), 'utf8');
  const control = readFileSync(join(root, '..', 'packages/warden/src/control.ts'), 'utf8');
  const serviceSrc = readFileSync(join(root, '..', 'packages/warden/src/service.ts'), 'utf8');
  const emissarySrc = readFileSync(join(root, '..', 'packages/emissary/src/index.ts'), 'utf8');
  check('makeWardenHandler enforces the delegated kinds (fail-closed)', /grantedKinds\.includes\(kind\)/.test(handlerSrc) && /not delegated for/.test(handlerSrc));
  check('the delegate route records the granted kinds', /delegations\.record\(emissaryDid, credentialDid, actor, grantKinds\)/.test(control));
  check('the Warden resolves an image asset via getImage (no base64)', /keymaster\.getImage\(payload\.assetDid\)/.test(serviceSrc));
  check('the Emissary creates a native image asset + ships the DID', /keymaster\.createImage\(bytes,/.test(emissarySrc) && /JSON\.stringify\(\{ assetDid, mediaType \}\)/.test(emissarySrc));

  process.stdout.write(
    failures === 0
      ? '\n✓ kind-and-asset: per-path kind-enforcement (fail-closed) + native image-asset transport (IPFS ref, not base64)\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kind-and-asset: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
