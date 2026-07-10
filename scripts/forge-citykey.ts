/**
 * Forge the Drake Gamers Guild board seal into a soulbis City Key + a droppable PNG.
 *
 * Reads the sealed game (`drake-gamers-guild.game42.json`), projects it via `game42ToCityKey`
 * (manifold geometry derived from the seal → a shape unique to this guild), stamps the soulbis κ, and
 * writes `drake-gamers-guild.citykey.json` + `drake-gamers-guild.citykey.png` (a `cityKey` base64-JSON
 * tEXt chunk, CRC32-valid — drops straight onto `/star` and charges at `/city`).
 *
 * Run:  node --experimental-strip-types scripts/forge-citykey.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { game42ToCityKey, GAME42_AXIS_VERTEX, type CityKey } from '@hearthold/core';

const here = dirname(fileURLToPath(import.meta.url));
const DEMO = join(here, '..', 'demos', 'game-of-42');

// Officer seated on each axis (mirrors seat-drake-gamers.ts) — used for the lit-vertex descriptions.
const OFFICER: Record<string, string> = {
  protection: 'The Warden (Soulbis)',
  delegation: 'The Emissary (Soulbae)',
  memory: 'The Lorekeeper',
  connection: 'The Quartermaster',
  compute: 'GenitriX',
  value: 'The Sovereign',
};

// ── minimal PNG writer + cityKey tEXt chunk (ports star/index.html pngEmbedKey) ──
const CRCT = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRCT[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcBuf = new Uint8Array(4 + data.length);
  crcBuf.set(out.subarray(4, 8), 0);
  crcBuf.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcBuf));
  return out;
}
function pngWithCityKey(cityKey: CityKey, size = 180): Buffer {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 (RGB)
  const [r, g, b] = [0x14, 0x1a, 0x3d]; // carrier 'cool'
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const off = y * (1 + size * 3);
    raw[off] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)));
  const kw = 'cityKey';
  const payload = Buffer.from(JSON.stringify(cityKey), 'utf8').toString('base64');
  const textData = new Uint8Array(kw.length + 1 + payload.length);
  for (let i = 0; i < kw.length; i++) textData[i] = kw.charCodeAt(i);
  textData[kw.length] = 0;
  for (let i = 0; i < payload.length; i++) textData[kw.length + 1 + i] = payload.charCodeAt(i);
  const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('tEXt', textData), chunk('IEND', new Uint8Array(0))];
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

function main(): void {
  const game = JSON.parse(readFileSync(join(DEMO, 'drake-gamers-guild.game42.json'), 'utf8')) as {
    groupSeal: string;
    binding: { community: string; roots: Record<string, string> };
  };

  const descriptionsByVertex: Record<number, string> = { 63: 'Drake Gamers Guild — all six dimensions held' };
  for (const [axis, vertex] of Object.entries(GAME42_AXIS_VERTEX)) {
    descriptionsByVertex[vertex] = `${axis} · ${OFFICER[axis] ?? ''}`.trim();
  }

  const key = game42ToCityKey({
    name: 'Drake Gamers Guild · game of 42 seal',
    groupSeal: game.groupSeal,
    savedAt: '2026-06-30T12:00:00Z',
    descriptionsByVertex,
    identity: { guild: 'Drake Gamers Guild', community: game.binding.community },
  });

  writeFileSync(join(DEMO, 'drake-gamers-guild.citykey.json'), JSON.stringify(key, null, 2) + '\n', 'utf8');
  const png = pngWithCityKey(key);
  writeFileSync(join(DEMO, 'drake-gamers-guild.citykey.png'), png);

  process.stdout.write('Forged the Drake Gamers Guild City Key 🗝️\n');
  process.stdout.write(`  seal (packets.root): ${game.groupSeal}\n`);
  process.stdout.write(`  manifold geometry (from seal): ${JSON.stringify(key.geometry)}\n`);
  process.stdout.write(`  lit vertices: ${JSON.stringify(key.lit)}\n`);
  process.stdout.write(`  City Key κ: ${key.kappa}\n`);
  process.stdout.write(`  → ${join(DEMO, 'drake-gamers-guild.citykey.json')}\n`);
  process.stdout.write(`  → ${join(DEMO, 'drake-gamers-guild.citykey.png')} (${png.length}B — drop on /star)\n`);
}

main();
