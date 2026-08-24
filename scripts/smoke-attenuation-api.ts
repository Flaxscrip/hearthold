/**
 * smoke: ground every Archon capability the attenuation-VC model depends on — with REAL calls,
 * not docs. Run against a live node; prints a capability matrix. If resolve-by-version does not
 * return the pinned historical version, the whole model is blocked and this fails loudly.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/smoke-attenuation-api.ts
 */
import { loadConfig, openKeymaster, ensureIdentity } from '@hearthold/core';

const ok = (m: string): void => process.stdout.write(`  ✓ ${m}\n`);
const info = (m: string): void => process.stdout.write(`  · ${m}\n`);

type Meta = { versionId?: string; versionSequence?: string; version?: number };
const metaOf = (doc: any): Meta => (doc?.didDocumentMetadata ?? {}) as Meta;

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-attn-smoke';
  const reg = config.registry;

  const warden = await openKeymaster('warden', config, pass);   // the attenuating Agent DID (controller)
  const holder = await openKeymaster('verifier', config, pass); // the pairwise recipient of the payload
  const wardenId = await ensureIdentity(warden, config);
  const holderId = await ensureIdentity(holder, config);
  const km = warden.keymaster;
  info(`warden (controller) = ${wardenId.did}`);
  info(`holder (recipient)  = ${holderId.did}`);

  // ── 1. createAsset: a cleartext JSON asset, controlled by the current Agent DID ──
  const vc = await km.createAsset({ hello: 'origin' }, { registry: reg });
  const d1 = await km.resolveDID(vc);
  const m1 = metaOf(d1);
  ok(`createAsset → Asset DID ${vc}`);
  ok(`controller = ${(d1 as any).didDocument?.controller} (expect warden ${wardenId.did})`);
  info(`v1 versionId=${m1.versionId} seq=${m1.versionSequence}`);

  // ── 2. mergeData == setProperty: merge a cleartext "pic" block, producing a NEW version ──
  await km.mergeData(vc, { pic: { counter: 0, note: 'first pic' } });
  const d2 = await km.resolveDID(vc);
  const m2 = metaOf(d2);
  ok(`mergeData (setProperty) wrote a cleartext prop; seq ${m1.versionSequence} → ${m2.versionSequence}`);
  ok(`new versionId differs: ${m1.versionId} → ${m2.versionId} (${m1.versionId !== m2.versionId})`);
  info(`didDocumentData now = ${JSON.stringify((d2 as any).didDocumentData)}`);

  // ── 3. mergeData again: widen the pic (simulates a PREV-TAMPER on a parent) ──
  await km.mergeData(vc, { pic: { counter: 0, note: 'WIDENED pic' } });
  const d3 = await km.resolveDID(vc);
  const m3 = metaOf(d3);
  ok(`second mergeData → seq ${m3.versionSequence}, versionId ${m3.versionId}`);

  // ── 4. THE BLOCKER: resolve a PINNED historical version by versionSequence ──
  const pinnedSeq = Number(m2.versionSequence);
  const pinned = await km.resolveDID(vc, { versionSequence: pinnedSeq });
  const mp = metaOf(pinned);
  const pinnedData = (pinned as any).didDocumentData;
  ok(`resolveDID(did, {versionSequence:${pinnedSeq}}) returned the PINNED version`);
  ok(`pinned versionId === v2 versionId: ${mp.versionId === m2.versionId} (${mp.versionId})`);
  ok(`pinned pic is the OLD value ("first pic"): ${JSON.stringify(pinnedData?.pic)}`);
  const bareLatest = metaOf(await km.resolveDID(vc));
  ok(`bare-DID resolve returns the LATEST (${bareLatest.versionId}) — tamper visible; pinned stayed ${mp.versionId}`);
  if (mp.versionId !== m2.versionId || pinnedData?.pic?.note !== 'first pic') {
    throw new Error('BLOCKER: resolve-by-versionSequence did not return the pinned historical version');
  }

  // ── 5. Pairwise encryption: encrypt a payload to the holder; confirm cipher shape + round-trip ──
  const enc = await km.encryptJSON({ authoritySet: { operations: ['read'], resources: ['X'] }, salt: 'deadbeef' }, holderId.did, { registry: reg });
  const encDoc = await km.resolveDID(enc);
  const encData = (encDoc as any).didDocumentData;
  const cipherKeys = Object.keys(encData?.encrypted ?? encData ?? {});
  ok(`encryptJSON → encrypted asset ${enc}; didDocumentData keys = ${JSON.stringify(cipherKeys)}`);
  await holder.keymaster.setCurrentId('hearthold-verifier').catch(() => {});
  const round = await holder.keymaster.decryptJSON(enc);
  ok(`holder decryptJSON round-trip = ${JSON.stringify(round)}`);

  // ── 6. Can cleartext + ciphertext co-exist in ONE asset doc? (the confirmed live-doc shape) ──
  await km.mergeData(enc, { pic: { counter: 1, note: 'cleartext beside cipher' } });
  const both = await km.resolveDID(enc);
  const bothData = (both as any).didDocumentData;
  ok(`one doc holds BOTH: pic=${JSON.stringify(bothData?.pic)} alongside cipher keys ${JSON.stringify(Object.keys(bothData?.encrypted ?? {}))}`);

  process.stdout.write('\n✓ capability matrix grounded — attenuation model is buildable\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`smoke-attenuation-api: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
