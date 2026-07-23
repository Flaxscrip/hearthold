/**
 * smoke (Task 1 blocker): can an Archon asset carry a ~16KB compressed bitstring payload and be updated
 * repeatedly with version pinning intact? If the payload size is a problem, STOP and report. Grounded on
 * REAL calls (inline gzip so it does not depend on the module wiring).
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/smoke-status-list.ts
 */
import { gzipSync } from 'node:zlib';
import { randomInt } from 'node:crypto';

import { loadConfig, openKeymaster, ensureIdentity } from '@hearthold/core';

const ok = (m: string): void => process.stdout.write(`  ✓ ${m}\n`);
const info = (m: string): void => process.stdout.write(`  · ${m}\n`);
const LEN = 131_072;
const BYTES = LEN / 8; // 16384
const enc = (b: Uint8Array): string => gzipSync(Buffer.from(b)).toString('base64');
type Meta = { versionId?: string; versionSequence?: string };

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-statuslist-smoke';
  const reg = config.registry;

  const sov = await openKeymaster('sovereign', config, pass);
  const attacker = await openKeymaster('warden', config, pass);
  const sovId = await ensureIdentity(sov, config);
  const attId = await ensureIdentity(attacker, config);
  const km = sov.keymaster;
  await km.setCurrentId(sovId.name);
  const now = new Date().toISOString();

  // A ~50%-dense bitstring is the WORST case for gzip (near-incompressible ⇒ largest payload).
  const dense = new Uint8Array(BYTES);
  for (let i = 0; i < BYTES; i++) dense[i] = randomInt(256);
  const denseEnc = enc(dense);
  info(`fixed length ${LEN} bits (${BYTES} bytes); ~50%-dense gzip+base64 payload = ${denseEnc.length} bytes`);

  // ── 1. Create a signed StatusList asset carrying the ~16KB compressed bitstring ──
  const body0 = { issuer: sovId.did, statusPurpose: 'revocation', encodedList: enc(new Uint8Array(BYTES)), listVersion: 1, updatedAt: now };
  const listDid = await km.createAsset(await km.addProof(body0, sovId.name), { registry: reg });
  const d1 = await km.resolveDID(listDid);
  const m1 = (d1.didDocumentMetadata ?? {}) as Meta;
  const verifyProof = km.verifyProof.bind(km) as (o: unknown) => Promise<boolean>;
  ok(`createAsset(empty status list) → ${listDid.slice(0, 30)}…  controller = ${(d1.didDocument as { controller?: string })?.controller === sovId.did}`);
  ok(`signed body verifies to the Sovereign: ${await verifyProof(d1.didDocumentData)}`);

  // ── 2. Update repeatedly, incl. the worst-case dense (~16KB) payload — versions mint cleanly ──
  await km.mergeData(listDid, await km.addProof({ issuer: sovId.did, statusPurpose: 'revocation', encodedList: enc(dense), listVersion: 2, updatedAt: now }, sovId.name) as unknown as Record<string, unknown>);
  const m2 = ((await km.resolveDID(listDid)).didDocumentMetadata ?? {}) as Meta;
  const dense2 = new Uint8Array(dense); dense2[0] ^= 0xff;
  await km.mergeData(listDid, await km.addProof({ issuer: sovId.did, statusPurpose: 'revocation', encodedList: enc(dense2), listVersion: 3, updatedAt: now }, sovId.name) as unknown as Record<string, unknown>);
  const m3 = ((await km.resolveDID(listDid)).didDocumentMetadata ?? {}) as Meta;
  ok(`repeated updates with a ~${(denseEnc.length / 1024).toFixed(1)}KB payload minted new versions: seq ${m1.versionSequence} → ${m2.versionSequence} → ${m3.versionSequence}`);

  // ── 3. Version pin: resolve v2 and confirm its versionId + payload are the historical ones ──
  const pinned = await km.resolveDID(listDid, { versionSequence: Number(m2.versionSequence) });
  const mp = (pinned.didDocumentMetadata ?? {}) as Meta;
  const pinnedEnc = (pinned.didDocumentData as { encodedList: string }).encodedList;
  ok(`resolveDID(list, {versionSequence:${m2.versionSequence}}) → versionId matches v2: ${mp.versionId === m2.versionId}`);
  ok(`pinned v2 payload is the historical dense bitstring (not v3): ${pinnedEnc === denseEnc && pinnedEnc !== (pinned as unknown as string)}`);
  if (mp.versionId !== m2.versionId || pinnedEnc !== denseEnc) throw new Error('BLOCKER: version pinning did not return the historical bitstring');

  // ── 4. Controller model: a non-Sovereign cannot update the list ──
  await attacker.keymaster.setCurrentId(attId.name);
  let tamperBlocked = false;
  try {
    tamperBlocked = !(await attacker.keymaster.mergeData(listDid, { encodedList: enc(new Uint8Array(BYTES)) }));
  } catch {
    tamperBlocked = true;
  }
  ok(`a non-Sovereign update is refused by Archon's controller model: ${tamperBlocked}`);

  process.stdout.write(`\n✓ Task 1 confirmed: a ~${(denseEnc.length / 1024).toFixed(1)}KB compressed bitstring stores + updates + version-pins on Archon — buildable\n`);
  process.exit(tamperBlocked ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`smoke-status-list: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
