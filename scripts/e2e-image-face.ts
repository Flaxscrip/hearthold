/**
 * e2e: IMAGE CARD-FACE carries BYTES, not the asset reference (Sevenfold).
 *
 * A granted image face used to return base64 of the `{assetDid, mediaType}` REFERENCE with a non-image
 * mimeType — so the Table drew a JSON string. The Warden (which holds the wallet) must resolve the asset to
 * real image BYTES; a keyless browser can't. This proves: a granted PUBLIC image face returns the exact PNG
 * bytes + an `image/*` mimeType, the ladder is unchanged (a SEALED image stays obsidian), and an
 * unresolvable asset falls back to the on-device caption (never the raw reference).
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-image-face.ts
 */
import { deflateSync } from 'node:zlib';

import { loadConfig, openKeymaster, ensureIdentity, sealForWarden, contentId, Sensitivity, AuthzTier } from '@hearthold/core';
import { VaultStore, type Artefact } from '@hearthold/warden/store';
import { hydrateCardFace } from '@hearthold/warden/face';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

function crc32(b: Buffer): number { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function pc(t: string, d: Buffer): Buffer { const T = Buffer.from(t, 'ascii'); const L = Buffer.alloc(4); L.writeUInt32BE(d.length, 0); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(Buffer.concat([T, d])), 0); return Buffer.concat([L, T, d, C]); }
function png(w: number, h: number, r: number, g: number, b: number): Buffer { const s = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2; const rows: Buffer[] = []; for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; } rows.push(row); } return Buffer.concat([s, pc('IHDR', ih), pc('IDAT', deflateSync(Buffer.concat(rows))), pc('IEND', Buffer.alloc(0))]); }

async function main(): Promise<void> {
  const base = loadConfig();
  const config = { ...base, dataRoot: `${base.dataRoot}-image-face` };
  const warden = await openKeymaster('warden', config, 'hearthold-image-face-e2e');
  const wid = await ensureIdentity(warden, config);
  const store = new VaultStore(warden.dataFolder);

  const hydrate = (id: string, tier: AuthzTier) =>
    hydrateCardFace(warden, { artefactId: id, visible: () => true, achievedTier: async () => tier });

  const putImage = async (sensitivity: number, assetDid: string): Promise<string> => {
    const ciphertext = await sealForWarden(warden, wid.did, JSON.stringify({ assetDid, mediaType: 'image/png' }));
    const id = contentId(ciphertext, warden.cipher);
    const artefact: Artefact = {
      id, kind: 'image', observedAt: new Date('2026-08-04').toISOString(), storedAt: new Date('2026-08-04').toISOString(),
      sensitivity, ciphertext, metadata: { assetDid, description: 'a red square' },
    };
    await store.put(artefact);
    return id;
  };

  step('a native image asset is stored + referenced by an image artefact');
  const bytes = png(64, 64, 220, 20, 30);
  const assetDid = await warden.keymaster.createImage(bytes, { registry: base.registry });
  check('createImage returns an asset DID', typeof assetDid === 'string' && assetDid.startsWith('did:'));
  const pubId = await putImage(Sensitivity.PUBLIC, assetDid);
  const sealedId = await putImage(Sensitivity.SEALED, assetDid);

  step('a GRANTED public image face returns the real BYTES + an image/* mimeType (not the {assetDid} ref)');
  const face = await hydrate(pubId, AuthzTier.STANDING);
  check('granted', face.granted === true);
  check('mimeType is image/* (was application/json)', typeof face.mimeType === 'string' && face.mimeType.startsWith('image/'));
  const faceBytes = face.granted && face.face ? Buffer.from(face.face, 'base64') : Buffer.alloc(0);
  check('the face bytes are the resolved PNG, not the reference JSON', faceBytes.equals(bytes));
  check('the face is NOT the {assetDid} reference string', !faceBytes.toString('utf8').includes('assetDid'));

  step('the ladder is unchanged — a SEALED image stays obsidian (no bytes leak)');
  const sealed = await hydrate(sealedId, AuthzTier.STANDING);
  check('SEALED image refused at STANDING (obsidian)', sealed.granted === false && !('face' in sealed && (sealed as { face?: string }).face));

  step('an UNRESOLVABLE asset falls back to the on-device caption, never the raw reference');
  const badCipher = await sealForWarden(warden, wid.did, JSON.stringify({ assetDid: 'did:cid:doesnotresolve', mediaType: 'image/png' }));
  const badId = contentId(badCipher, warden.cipher);
  await store.put({ id: badId, kind: 'image', observedAt: badCipher && new Date('2026-08-04').toISOString(), storedAt: new Date('2026-08-04').toISOString(), sensitivity: Sensitivity.PUBLIC, ciphertext: badCipher, metadata: { assetDid: 'did:cid:doesnotresolve', description: 'a red square' } } as Artefact);
  const bad = await hydrate(badId, AuthzTier.STANDING);
  const badFace = bad.granted && bad.face ? Buffer.from(bad.face, 'base64').toString('utf8') : '';
  check('unresolvable → the caption text, not the assetDid reference', bad.granted === true && badFace === 'a red square' && !badFace.includes('assetDid'));

  process.stdout.write(
    failures === 0
      ? '\n✓ image-face: a granted image face carries resolved bytes + image/* mimeType; SEALED stays obsidian; unresolvable → caption\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-image-face: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
