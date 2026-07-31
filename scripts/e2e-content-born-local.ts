/**
 * e2e: CONTENT BORN LOCAL — new content/assets default to `local` regardless of the identity registry (Aegis).
 * Also source-scans the DIDComm receive loop so a failed-unpack is LOGGED, never silently swallowed (Aegis ask 1).
 *
 *   A · config: contentRegistry defaults to `local` and is INDEPENDENT of the identity registry
 *       (HEARTHOLD_REGISTRY=hyperswarm still ⇒ content local).
 *   B · live: a created image asset AND a vault credential are registered on `local` (born local).
 *   C · source-scan: openKeymaster defaults content to contentRegistry while the identity uses config.registry;
 *       the transport logs unpack failures.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 node --experimental-strip-types scripts/e2e-content-born-local.ts
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
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

function crc32(b: Buffer): number { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function pc(t: string, d: Buffer): Buffer { const T = Buffer.from(t, 'ascii'); const L = Buffer.alloc(4); L.writeUInt32BE(d.length, 0); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(Buffer.concat([T, d])), 0); return Buffer.concat([L, T, d, C]); }
function png(): Buffer { const w = 32, h = 32; const s = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2; const rows: Buffer[] = []; for (let y = 0; y < h; y++) { const r = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { r[1 + x * 3] = 40; r[2 + x * 3] = 80; r[3 + x * 3] = 160; } rows.push(r); } return Buffer.concat([s, pc('IHDR', ih), pc('IDAT', deflateSync(Buffer.concat(rows))), pc('IEND', Buffer.alloc(0))]); }

async function main(): Promise<void> {
  step('A · config — contentRegistry is `local` by default and independent of the identity registry');
  check('default: contentRegistry = local', loadConfig({}).contentRegistry === 'local');
  const fed = loadConfig({ HEARTHOLD_REGISTRY: 'hyperswarm' });
  check('a FEDERATED identity (registry=hyperswarm) still has contentRegistry=local', fed.registry === 'hyperswarm' && fed.contentRegistry === 'local');
  check('an operator can override content too', loadConfig({ HEARTHOLD_CONTENT_REGISTRY: 'hyperswarm' }).contentRegistry === 'hyperswarm');

  step('B · live — a created image asset and a vault credential are BORN LOCAL');
  const base = loadConfig();
  const config = { ...base, dataRoot: `${base.dataRoot}-born-local` };
  const warden = await openKeymaster('warden', config, process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-born-local-e2e');
  const wid = await ensureIdentity(warden, config);
  const registryOf = async (did: string): Promise<string | undefined> => {
    const doc = (await warden.keymaster.resolveDID(did)) as { didDocumentRegistration?: { registry?: string } };
    return doc.didDocumentRegistration?.registry;
  };

  const assetDid = await warden.keymaster.createImage(png(), { registry: config.contentRegistry });
  check('an image asset is registered on `local`', (await registryOf(assetDid)) === 'local');

  const schema = await ensureDelegationSchema(warden);
  const credDid = await issueDelegation(warden, wid.did, schema, { kinds: ['document'], validUntil: new Date(Date.now() + 1e10).toISOString() });
  check('a vault credential (delegation VC) is registered on `local`', (await registryOf(credDid)) === 'local');
  check('so is a schema asset (content, not identity)', (await registryOf(schema)) === 'local');

  step('C · source-scan — the wiring: content defaults local, identity keeps its registry; unpack failures logged');
  const root = dirname(fileURLToPath(import.meta.url));
  const km = readFileSync(join(root, '..', 'packages/core/src/keymaster.ts'), 'utf8');
  const identity = readFileSync(join(root, '..', 'packages/core/src/identity.ts'), 'utf8');
  const transport = readFileSync(join(root, '..', 'packages/core/src/transport.ts'), 'utf8');
  const emissary = readFileSync(join(root, '..', 'packages/emissary/src/index.ts'), 'utf8');
  check('openKeymaster defaults content to contentRegistry', /defaultRegistry: config\.contentRegistry/.test(km));
  check('the identity itself is created on config.registry (still federates)', /createId\(name, \{ registry: config\.registry \}\)/.test(identity));
  check('the Emissary creates its image asset on contentRegistry', /createImage\(bytes, \{ registry: config\.contentRegistry \}\)/.test(emissary));
  check('Ask 1: the receive loop LOGS an unpack failure (no longer swallowed)', /receiveDidComm\/unpack FAILED/.test(transport) && /no verified sender/.test(transport));

  process.stdout.write(
    failures === 0
      ? '\n✓ content-born-local: content defaults `local` independent of identity registry; identity federates; unpack failures surfaced\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-content-born-local: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
