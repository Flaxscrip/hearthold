/**
 * e2e: DAEMON IMAGE SUBMIT — the Table's image contribution over the RELIABLE daemon path (Aegis).
 *
 * The `emissary submit-image` CLI is racy (~50%): it runs as a SEPARATE process from the `emissary control`
 * daemon, so two readers poll the same mailbox and race on the destructive `receiveDidComm` — the ack meant
 * for the CLI's request can be consumed by the daemon's serve loop → false timeout. The daemon's own
 * `POST /api/submit` has ONE reader (the serve loop resolves replies by thid), so it's reliable. This proves
 * the image/attachment path now rides that reliable route:
 *
 *   Table  → POST :PORT/api/submit { kind:'image', attachment:{ mediaType, bytesB64 } }
 *   Daemon → createImage(bytes) → node IPFS (born local) → seals { assetDid, mediaType } → WitnessSubmission
 *   Warden → ack-before-caption → get-image → caption on-device → born-obsidian in triage
 *   Daemon loop correlates the receipt by thid → SSE 'receipt' (single reader, no contention)
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-daemon-image-submit.ts
 */
import { deflateSync } from 'node:zlib';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  DidCommTransport,
  IDENTITY_NAME,
  Sensitivity,
  type KeymasterHandle,
} from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { VaultStore } from '@hearthold/warden/store';
import { DelegationStore } from '@hearthold/warden/delegations';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { ChallengeStore } from '@hearthold/warden/challenge-store';
import { OllamaVisionCaptioner } from '@hearthold/warden/vision';
import type { Classifier } from '@hearthold/warden/classifier';
import { runEmissaryControl } from '@hearthold/emissary/control';

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

const PORT = 4362; // out of the way of the standard control ports

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-daemon-image-e2e';
  const root = `${base.dataRoot}-daemon-image`;
  const wardenCfg = { ...base, dataRoot: `${root}/warden` };
  // caption only if the vision model is present; the reliable-path assertions don't need it.
  const tags = await fetch(`${base.ollamaUrl}/api/tags`).then((r) => r.json()).then((d: unknown) => (d as { models?: { name?: string }[] }).models?.map((m) => m.name ?? '') ?? []).catch(() => [] as string[]);
  const haveVision = tags.some((n) => n.startsWith(base.visionModel));

  step('Provision the Warden + the image Emissary (its own identity, image-only delegation)');
  const warden: KeymasterHandle = await openKeymaster('warden', wardenCfg, pass);
  const emissary: KeymasterHandle = await openKeymaster('emissary', { ...base, dataRoot: `${root}/emissary` }, pass);
  const wardenId = await ensureIdentity(warden, wardenCfg);
  const emissaryId = await ensureIdentity(emissary, { ...base, dataRoot: `${root}/emissary` });
  check('warden + emissary ready', wardenId.did.startsWith('did:') && emissaryId.did.startsWith('did:'));

  const schema = await ensureDelegationSchema(warden);
  const validUntil = new Date(Date.now() + 1e10).toISOString();
  const cred = await issueDelegation(warden, emissaryId.did, schema, { kinds: ['image'], validUntil });
  const delegations = new DelegationStore(warden);
  await delegations.record(emissaryId.did, cred, undefined, ['image']);
  check('image-only delegation issued + recorded', cred.startsWith('did:'));

  step('Warden serves over DIDComm (ack-before-caption; born-obsidian ingestion gate)');
  const store = new VaultStore(warden.dataFolder);
  const svc = new WardenService(warden, stubClassifier, stubEmbedder, haveVision ? new OllamaVisionCaptioner(base.ollamaUrl, base.visionModel) : undefined);
  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, wardenCfg.nodeUrl);
  await wardenTransport.ready();
  const challenges = new ChallengeStore(warden, wardenCfg.registry);
  const stopWarden = await wardenTransport.serve(
    makeWardenHandler(svc, delegations, undefined, undefined, wardenId.did, { confirmAtOrBelow: Sensitivity.SEALED, isAutofileTrusted: async () => false }, undefined, challenges),
    { pollMs: 1000 },
  );

  step('Boot the Emissary control daemon (the reliable single-reader mailbox owner)');
  // The daemon reads config.wardenDid to address submissions.
  const emissaryCfg = { ...base, dataRoot: `${root}/emissary`, wardenDid: wardenId.did };
  await runEmissaryControl(emissary, emissaryCfg, PORT);
  check('daemon control listening', true);

  try {
    step('Table → POST /api/submit with an image ATTACHMENT (no base64 in DIDComm; a native asset DID rides)');
    const bytes = png(80, 80, 40, 160, 210);
    const res = await fetch(`http://127.0.0.1:${PORT}/api/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'image', attachment: { mediaType: 'image/png', bytesB64: bytes.toString('base64') } }),
    });
    const json = (await res.json()) as { receipt?: { id: string; kind: string; status: string } };
    check('the daemon accepts the attachment (provisional receipt)', res.status === 200 && json.receipt?.kind === 'image' && json.receipt?.status === 'submitted');

    step('The image crosses the reliable path + lands born-obsidian in the Warden vault');
    // ack-before-caption + the two poll loops → give it a few seconds; poll the vault for an image artefact.
    let art: Awaited<ReturnType<typeof store.get>> | undefined;
    for (let i = 0; i < 60 && !art; i++) {
      const all = await store.list();
      art = all.find((a) => a.kind === 'image');
      if (!art) await new Promise((r) => setTimeout(r, 500));
    }
    check('an image artefact landed via the daemon HTTP path (no CLI, no race)', !!art);
    check('it references a NATIVE image asset DID (bytes went to IPFS, not base64 over DIDComm)', typeof art?.metadata?.assetDid === 'string' && (art!.metadata!.assetDid as string).startsWith('did:'));
    check('born-obsidian — an image is a proposal, quarantined until the Sovereign admits', art?.metadata?.needsHumanConfirmation === true);
    if (haveVision) {
      check('captioned on-device from the IPFS bytes (has a description)', typeof art?.metadata?.description === 'string' && (art!.metadata!.description as string).length > 0);
    } else {
      process.stdout.write(`  ⓘ caption assertion skipped: no '${base.visionModel}' on ${base.ollamaUrl}\n`);
    }

    step('Guardrails — a malformed attachment is refused up front (not a silent bad submission)');
    const bad = await fetch(`http://127.0.0.1:${PORT}/api/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'image', attachment: { mediaType: 'image/png', bytesB64: '' } }),
    });
    check('empty attachment bytes → 4xx (bad base64 caught)', bad.status >= 400);
    const noPayload = await fetch(`http://127.0.0.1:${PORT}/api/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'document' }),
    });
    check('neither text nor attachment → 4xx (a submission must carry a payload)', noPayload.status >= 400);
  } finally {
    stopWarden();
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ daemon-image-submit: the Table image contribution rides the reliable daemon (native asset, born-obsidian); malformed attachments refused\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-daemon-image-submit: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
