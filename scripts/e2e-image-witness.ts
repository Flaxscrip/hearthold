/**
 * e2e: IMAGE WITNESS — caption-then-classify, reusing the whole pipeline (Aegis).
 *
 *   A (stub, deterministic): an `image` submission is captioned → the CAPTION is classified, stored as the
 *      artefact's description/tags, and EMBEDDED (never the bytes); it inherits the ingestion gate (quarantined
 *      by default), and admits/indexes on confirm. A vision failure fails CLOSED to SEALED.
 *   B (live): the real local vision model (moondream) captions a generated image → non-empty description that
 *      flows through classification. Skipped if no vision model is installed.
 *   C (source-scan): the wiring — kind 'image', config default moondream, control wires the captioner,
 *      handleSubmission captions-then-classifies, indexArtefact embeds the caption for images.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local HEARTHOLD_OLLAMA_URL=… \
 *   node --experimental-strip-types scripts/e2e-image-witness.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  sealForWarden,
  Sensitivity,
  PROTOCOL_VERSION,
  type WitnessSubmission,
} from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { IndexStore } from '@hearthold/warden/index-store';
import { VaultStore } from '@hearthold/warden/store';
import type { Classifier } from '@hearthold/warden/classifier';
import { OllamaVisionCaptioner, type VisionCaptioner } from '@hearthold/warden/vision';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const stubClassifier = (sensitivity: Sensitivity): Classifier => ({
  async classify(input) {
    // Prove the CAPTION (not the base64) is what reaches the classifier: echo it into metadata.
    return { sensitivity, metadata: { classifiedText: input.text }, needsHumanConfirmation: false };
  },
});
const stubCaptioner: VisionCaptioner = { async caption() { return { description: 'a photo of a cat on a red sofa', tags: ['cat', 'sofa', 'indoor'] }; } };
const nullCaptioner: VisionCaptioner = { async caption() { return null; } };

// A recording embedder — captures the text embedded so we can assert it's the caption, never the image bytes.
const recordingEmbedder = () => {
  const embedded: string[] = [];
  return { embedded, async embed(t: string): Promise<number[]> { embedded.push(t); return [1, 0]; } };
};

// Minimal solid-colour PNG (self-contained; avoids shipping a fixture).
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function solidPngB64(w: number, h: number, r: number, g: number, b: number): string {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; } rows.push(row); }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
}

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-image-witness-e2e';
  const config = { ...base, dataRoot: `${base.dataRoot}-image-witness` };
  const warden = await openKeymaster('warden', config, pass);
  const wid = await ensureIdentity(warden, config);
  const store = new VaultStore(warden.dataFolder);
  const index = new IndexStore(warden.dataFolder);
  const imagePayload = JSON.stringify({ image: { mediaType: 'image/png', bytesB64: 'ZmFrZWJ5dGVz' } });
  const submitImage = async (svc: WardenService, policy?: { autofileTrusted?: boolean }) => {
    const ciphertext = await sealForWarden(warden, wid.did, imagePayload);
    const submission: WitnessSubmission = { type: 'hearthold/witness-submission', version: PROTOCOL_VERSION, kind: 'image', observedAt: new Date('2026-07-30').toISOString(), ciphertext };
    return svc.handleSubmission(submission, wid.did, undefined, policy);
  };

  step('A · caption-then-classify: the caption is classified + stored + embedded (not the bytes); inherits the gate');
  {
    const emb = recordingEmbedder();
    const svc = new WardenService(warden, stubClassifier(Sensitivity.LOW), emb, stubCaptioner);
    const r = await submitImage(svc); // default policy → quarantine
    const art = await store.get(r.artefactId);
    check('the image artefact stores the vision caption as its description', art?.metadata?.description === 'a photo of a cat on a red sofa');
    check('and the vision tags', Array.isArray(art?.metadata?.tags) && (art!.metadata!.tags as string[]).includes('cat'));
    check('the CAPTION (not base64 bytes) is what the classifier saw', art?.metadata?.classifiedText === 'a photo of a cat on a red sofa');
    check('an image submission inherits the ingestion gate → quarantined by default', art?.metadata?.needsHumanConfirmation === true);
    check('quarantined → NOT indexed at submit', (await index.has(r.artefactId)) === false);
    // Admission → indexes the CAPTION, never the image bytes.
    await svc.indexArtefact((await store.get(r.artefactId))!);
    check('on admission it indexes, embedding the CAPTION (not base64)', (await index.has(r.artefactId)) && emb.embedded.includes('a photo of a cat on a red sofa') && !emb.embedded.some((t) => t.includes('ZmFrZQ') || t.includes('bytes')));
  }

  step('A · autofile-trusted image auto-admits + indexes; a vision FAILURE fails closed to SEALED + quarantine');
  {
    const svc = new WardenService(warden, stubClassifier(Sensitivity.LOW), recordingEmbedder(), stubCaptioner);
    const trusted = await submitImage(svc, { autofileTrusted: true });
    check('autofile-trusted image → admitted + indexed', !(await store.get(trusted.artefactId))?.metadata?.needsHumanConfirmation && (await index.has(trusted.artefactId)));

    const failSvc = new WardenService(warden, stubClassifier(Sensitivity.LOW), recordingEmbedder(), nullCaptioner);
    const failed = await submitImage(failSvc, { autofileTrusted: true });
    const fa = await store.get(failed.artefactId);
    check('vision failure → classified SEALED (fail-closed)', fa?.sensitivity === Sensitivity.SEALED);
    check('vision failure → quarantined even when autofile-trusted (never leaks)', fa?.metadata?.needsHumanConfirmation === true && (await index.has(failed.artefactId)) === false);
  }

  step('B · LIVE — the local vision model captions a generated image (skipped if none installed)');
  const visionModel = base.visionModel;
  const tags = await fetch(`${base.ollamaUrl}/api/tags`).then((r) => r.json()).then((d: unknown) => (d as { models?: { name?: string }[] }).models?.map((m) => m.name ?? '') ?? []).catch(() => [] as string[]);
  const hasVision = tags.some((n) => n.startsWith(visionModel));
  if (!hasVision) {
    process.stdout.write(`  ⓘ skipped: no '${visionModel}' vision model on ${base.ollamaUrl}\n`);
  } else {
    const captioner = new OllamaVisionCaptioner(base.ollamaUrl, visionModel);
    const cap = await captioner.caption({ bytesB64: solidPngB64(96, 96, 200, 30, 40), mediaType: 'image/png' });
    check(`'${visionModel}' returns a non-empty caption for a real image`, !!cap && cap.description.length > 0);
    if (cap) process.stdout.write(`     caption: "${cap.description.slice(0, 100)}"\n`);
    // Full live pipeline: submit through handleSubmission with the real captioner → captioned + quarantined.
    const liveSvc = new WardenService(warden, stubClassifier(Sensitivity.MEDIUM), recordingEmbedder(), captioner);
    const liveB64 = solidPngB64(96, 96, 30, 120, 200);
    const ciphertext = await sealForWarden(warden, wid.did, JSON.stringify({ image: { mediaType: 'image/png', bytesB64: liveB64 } }));
    const rr = await liveSvc.handleSubmission({ type: 'hearthold/witness-submission', version: PROTOCOL_VERSION, kind: 'image', observedAt: new Date('2026-07-30').toISOString(), ciphertext }, wid.did);
    const liveArt = await store.get(rr.artefactId);
    check('the live image submission carries a vision description + is quarantined', typeof liveArt?.metadata?.description === 'string' && (liveArt!.metadata!.description as string).length > 0 && liveArt?.metadata?.needsHumanConfirmation === true);
  }

  step('C · source-scan — the wiring holds');
  const root = dirname(fileURLToPath(import.meta.url));
  const proto = readFileSync(join(root, '..', 'packages/core/src/protocol.ts'), 'utf8');
  const cfg = readFileSync(join(root, '..', 'packages/core/src/config.ts'), 'utf8');
  const control = readFileSync(join(root, '..', 'packages/warden/src/control.ts'), 'utf8');
  const service = readFileSync(join(root, '..', 'packages/warden/src/service.ts'), 'utf8');
  check("WitnessKind includes 'image'", /'document' \| 'image'/.test(proto));
  check('config defaults the vision model to moondream', /DEFAULT_VISION_MODEL = 'moondream'/.test(cfg));
  check('the control plane wires the vision captioner into WardenService', /createVisionCaptioner\(config\)/.test(control));
  check('handleSubmission captions an image then classifies the caption', /submission\.kind === 'image'/.test(service) && /this\.captionImage\(plaintext\)/.test(service));
  check('indexArtefact embeds the caption (description), never the image bytes', /artefact\.kind === 'image' \? undefined/.test(service));

  process.stdout.write(
    failures === 0
      ? '\n✓ image-witness: caption-then-classify reuses the whole pipeline (gate + triage + recall); vision failure fails closed\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-image-witness: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
