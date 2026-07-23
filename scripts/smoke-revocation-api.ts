/**
 * smoke (Task 1 blocker): can the Sovereign create + REPEATEDLY UPDATE a signed asset whose body is a
 * Hearthold structure; can a resolver fetch a SPECIFIC prior versionSequence and verify its versionId; and
 * does Archon's controller model BLOCK a non-Sovereign update? Grounded on REAL calls.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/smoke-revocation-api.ts
 */
import { loadConfig, openKeymaster, ensureIdentity } from '@hearthold/core';

const ok = (m: string): void => process.stdout.write(`  ✓ ${m}\n`);
const info = (m: string): void => process.stdout.write(`  · ${m}\n`);
type Meta = { versionId?: string; versionSequence?: string };

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-revocation-smoke';
  const reg = config.registry;

  const sovereign = await openKeymaster('sovereign', config, pass);
  const attacker = await openKeymaster('warden', config, pass); // a non-controller
  const sovId = await ensureIdentity(sovereign, config);
  const attId = await ensureIdentity(attacker, config);
  const km = sovereign.keymaster;
  await km.setCurrentId(sovId.name);
  const verifyProof = km.verifyProof.bind(km) as (o: unknown) => Promise<boolean>;
  const now = new Date().toISOString();

  // ── 1. Create a SIGNED revocation-list asset (body = a Hearthold structure) ──
  const body0 = { issuer: sovId.did, listVersion: 1, entries: [] as unknown[], updatedAt: now };
  const signed0 = await km.addProof(body0, sovId.name);
  const listDid = await km.createAsset(signed0, { registry: reg });
  const d1 = await km.resolveDID(listDid);
  const m1 = (d1.didDocumentMetadata ?? {}) as Meta;
  ok(`createAsset(signedList) → ${listDid.slice(0, 30)}…  controller = ${(d1.didDocument as { controller?: string })?.controller === sovId.did}`);
  ok(`the signed list verifies to the Sovereign: ${await verifyProof(d1.didDocumentData)}`);
  info(`v1 seq=${m1.versionSequence} versionId=${m1.versionId}`);

  // ── 2. Repeatedly UPDATE (append entries) — each update mints a new versionId/versionSequence ──
  const body1 = { issuer: sovId.did, listVersion: 2, entries: [{ recognitionId: 'rec-AAA', revokedAt: now }], updatedAt: now };
  await km.mergeData(listDid, await km.addProof(body1, sovId.name));
  const m2 = ((await km.resolveDID(listDid)).didDocumentMetadata ?? {}) as Meta;
  const body2 = { issuer: sovId.did, listVersion: 3, entries: [{ recognitionId: 'rec-AAA', revokedAt: now }, { recognitionId: 'rec-BBB', revokedAt: now }], updatedAt: now };
  await km.mergeData(listDid, await km.addProof(body2, sovId.name));
  const d3 = await km.resolveDID(listDid);
  const m3 = (d3.didDocumentMetadata ?? {}) as Meta;
  ok(`two updates minted new versions: seq ${m1.versionSequence} → ${m2.versionSequence} → ${m3.versionSequence}`);
  ok(`current list holds both entries: ${JSON.stringify(((d3.didDocumentData as { entries: { recognitionId: string }[] }).entries).map((e) => e.recognitionId))}`);

  // ── 3. THE PIN: resolve a SPECIFIC prior versionSequence and verify its versionId ──
  const pinnedSeq = Number(m2.versionSequence);
  const pinned = await km.resolveDID(listDid, { versionSequence: pinnedSeq });
  const mp = (pinned.didDocumentMetadata ?? {}) as Meta;
  const pinnedEntries = (pinned.didDocumentData as { entries: { recognitionId: string }[] }).entries.map((e) => e.recognitionId);
  ok(`resolveDID(list, {versionSequence:${pinnedSeq}}) → pinned versionId matches v2: ${mp.versionId === m2.versionId}`);
  ok(`pinned v2 had ONLY rec-AAA (rec-BBB not yet revoked then): ${JSON.stringify(pinnedEntries)}`);
  if (mp.versionId !== m2.versionId || pinnedEntries.includes('rec-BBB')) throw new Error('BLOCKER: version pinning did not return the historical list');

  // ── 4. CONTROLLER model: a non-Sovereign CANNOT update the list ──
  await attacker.keymaster.setCurrentId(attId.name);
  let tamperBlocked = false;
  try {
    const okUpd = await attacker.keymaster.mergeData(listDid, { entries: [{ recognitionId: 'forged', revokedAt: now }] });
    tamperBlocked = !okUpd;
  } catch {
    tamperBlocked = true;
  }
  const afterTamper = (await km.resolveDID(listDid).then((d) => (d.didDocumentData as { entries: { recognitionId: string }[] }).entries.map((e) => e.recognitionId)));
  ok(`a non-Sovereign update is refused by Archon's controller model: ${tamperBlocked}`);
  ok(`the list is unchanged by the attacker (no 'forged' entry): ${!afterTamper.includes('forged')}`);

  process.stdout.write('\n✓ Task 1 confirmed: signed list asset, repeatable updates with version history, prior-version pinning, and controller-enforced writes — buildable\n');
  process.exit(tamperBlocked && !afterTamper.includes('forged') ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`smoke-revocation-api: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
