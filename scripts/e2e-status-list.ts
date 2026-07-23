/**
 * e2e: W3C Bitstring Status List revocation — a fixed-size bitstring as an Archon asset, live.
 *
 * Replaces the recognitionId list (whose LENGTH was the revocation count) with a fixed 131,072-bit
 * bitstring: each recognition carries a RANDOM index, a set bit means revoked, verifiers fetch the whole
 * list (herd privacy). A correct REJECT is a PASS; the checker is never loosened. Run:
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-status-list.ts
 *
 * Matrix: HAPPY · REVOKED-BIT · PERSISTENCE · FAIL-CLOSED · AUDIT-REPLAY · CONTROLLER-TAMPER ·
 *         INDEX-RANDOMNESS · HERD-SIZE.
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  issueRecognition,
  presentRecognition,
  createStatusList,
  publishRevocation,
  auditRevocationAt,
  decodeBitstring,
  getBit,
  StatusListResolver,
  STATUS_LIST_LENGTH,
  STATUS_LIST_BYTES,
  MeshWarden,
  receiveAnswer,
  type MeshPolicy,
  type MeshQuery,
  type MeshQueryEnvelope,
  type PublicPartition,
  type SignedStatusList,
  type StatusListPin,
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-status-list-e2e';
  const reg = base.registry;
  const cfgA = { ...base, dataRoot: join(base.dataRoot, 'A') };
  const cfgB = { ...base, dataRoot: join(base.dataRoot, 'B') };

  step('Provision: A (Emissary/holder), B (Sovereign/issuer+owner, Warden/checker)');
  const aEmissary = await openKeymaster('emissary', cfgA, pass);
  const bSov = await openKeymaster('sovereign', cfgB, pass);
  const bWarden = await openKeymaster('warden', cfgB, pass);
  const aEmId = await ensureIdentity(aEmissary, cfgA);
  const bSovId = await ensureIdentity(bSov, cfgB);
  const bWardenId = await ensureIdentity(bWarden, cfgB);

  step('B\'s Sovereign creates a Bitstring StatusList asset + recognizes A (random index)');
  const { statusListCredential } = await createStatusList(bSov, bSovId.name, cfgB);
  const assigned = new Set<number>();
  const scope = { tier: 'trusted', confidence: 0.9, domain: 'fences', mode: 'fact' as const, maxDepth: 1 };
  const rec = await issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope, statusListCredential, registry: reg, assignedIndices: assigned });
  const rec2 = await issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope, statusListCredential, registry: reg, assignedIndices: assigned });
  check('StatusList + recognition issued (random index)', statusListCredential.startsWith('did:') && rec.statusListIndex >= 0 && rec.statusListIndex < STATUS_LIST_LENGTH);
  process.stdout.write(`      recognition status index = ${rec.statusListIndex} (of ${STATUS_LIST_LENGTH})\n`);

  const partition: PublicPartition = { domain: 'fences', facts: [{ ref: 'post-spacing', provenance: 'asserted', confidence: 1, keywords: ['post', 'spacing', 'apart'], narrative: 'Sovereign B asserts: set posts 8 feet on center.' }] };
  const query: MeshQuery = { text: 'how far apart should fence posts be?', mode: 'fact', domain: 'fences', depth: 1, budget: { maxNodes: 3, rate: 2 } };
  const envOf = (r = rec): MeshQueryEnvelope => ({ query, recognition: presentRecognition(r), presenterDid: aEmId.did });
  const policyWith = (s: StatusListResolver): MeshPolicy => ({ recognizedIssuer: bSovId.did, tier: 'trusted', maxArrivalDepth: 1, statusList: s });

  const liveResolver = new StatusListResolver(bWarden, { statusListCredential, expectedIssuer: bSovId.did, maxAgeMs: 0 });
  const meshB = new MeshWarden(bWarden, bWardenId.name, cfgB, policyWith(liveResolver), partition);

  // ── HAPPY ──
  step('HAPPY: unrevoked index → ACCEPT; the answer pins the StatusList version + checked-at');
  const res = await meshB.handle(envOf());
  check('B admits + answers', res.status === 'granted');
  let happyPin: StatusListPin | undefined;
  if (res.status === 'granted') {
    const recv = await receiveAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: res.answerDid, expectedIssuer: bWardenId.did });
    happyPin = recv.answer?.statusListVersion;
    check('answer carries statusCheckedAt', !!recv.answer?.statusCheckedAt);
    check('answer pins a StatusList version (versionSequence + versionId)', !!happyPin && happyPin.versionSequence > 0 && happyPin.versionId.length > 0);
  }

  // ── AUDIT-REPLAY (pre) ──
  step('AUDIT-REPLAY (pre): the answer\'s pinned version reads the bit as 0 + versionId matches');
  const auditBefore = await auditRevocationAt(bWarden, happyPin!, rec.statusListIndex);
  check('pinned version resolves and its versionId matches the answer', auditBefore.versionIdMatches);
  check('the bit was 0 (not revoked) at answer time', auditBefore.revokedThen === false);

  // ── REVOKED-BIT ──
  step('REVOKED-BIT: set the recognition\'s bit → REJECT; setting it twice is idempotent');
  const pub = await publishRevocation(bSov, bSovId.name, statusListCredential, rec.statusListIndex, cfgB);
  check('bit set (new list version)', pub.alreadyRevoked === false && pub.pin.versionSequence > (happyPin?.versionSequence ?? 0));
  const resRevoked = await meshB.handle(envOf());
  check('B REJECTS the now-revoked recognition', resRevoked.status === 'rejected' && resRevoked.check === 'revocation');
  if (resRevoked.status === 'rejected') process.stdout.write(`      → ${resRevoked.reason}\n`);
  const pub2 = await publishRevocation(bSov, bSovId.name, statusListCredential, rec.statusListIndex, cfgB);
  check('setting the bit twice is idempotent (no new version)', pub2.alreadyRevoked === true && pub2.pin.versionSequence === pub.pin.versionSequence);

  // ── AUDIT-REPLAY (post) ──
  step('AUDIT-REPLAY (post): current version\'s bit is 1; the pinned historical version still reads 0');
  const currentList = (await bWarden.keymaster.resolveDID(statusListCredential)).didDocumentData as SignedStatusList;
  check('the CURRENT bitstring has the bit set', getBit(decodeBitstring(currentList.encodedList), rec.statusListIndex));
  const auditAfter = await auditRevocationAt(bWarden, happyPin!, rec.statusListIndex);
  check('the pinned historical version STILL reads 0 (immutable history)', auditAfter.versionIdMatches && auditAfter.revokedThen === false);

  // ── PERSISTENCE ──
  step('PERSISTENCE: a FRESH Warden with NO in-memory state → still REJECTS the revoked recognition');
  const freshResolver = new StatusListResolver(bWarden, { statusListCredential, expectedIssuer: bSovId.did, maxAgeMs: 60_000 });
  const freshMeshB = new MeshWarden(bWarden, bWardenId.name, cfgB, policyWith(freshResolver), partition);
  const resFresh = await freshMeshB.handle(envOf());
  check('durable: a brand-new Warden reads the published bit and REJECTS', resFresh.status === 'rejected' && resFresh.check === 'revocation');

  // ── FAIL-CLOSED ──
  step('FAIL-CLOSED: an unresolvable StatusList → DENY, even for an unrevoked recognition');
  const badDid = 'did:cid:bagaaieranotarealstatuslist000000000000000000000000000000000';
  const recBad = await issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope, statusListCredential: badDid, registry: reg, assignedIndices: assigned });
  const badResolver = new StatusListResolver(bWarden, { statusListCredential: badDid, expectedIssuer: bSovId.did, maxAgeMs: 60_000 });
  const badMeshB = new MeshWarden(bWarden, bWardenId.name, cfgB, policyWith(badResolver), partition);
  const resFailClosed = await badMeshB.handle(envOf(recBad)); // recBad is unrevoked, but its list can't be resolved
  check('an unresolvable status list DENIES (fail-closed), never allows', resFailClosed.status === 'rejected' && resFailClosed.check === 'revocation');
  check('the denial is specifically fail-closed on unavailability', resFailClosed.status === 'rejected' && /fail-closed|unavailable|unresolvable/.test(resFailClosed.reason));
  if (resFailClosed.status === 'rejected') process.stdout.write(`      → ${resFailClosed.reason}\n`);

  // ── CONTROLLER-TAMPER ──
  step('CONTROLLER-TAMPER: a non-Sovereign attempts to update the list → refused by Archon\'s controller model');
  await bWarden.keymaster.setCurrentId(bWardenId.name); // B's Warden is NOT the list owner
  let tamperBlocked = false;
  try {
    const emptyEnc = (currentList.encodedList && (await import('node:zlib')).gzipSync(Buffer.from(new Uint8Array(STATUS_LIST_BYTES))).toString('base64'));
    tamperBlocked = !(await bWarden.keymaster.mergeData(statusListCredential, { encodedList: emptyEnc }));
  } catch {
    tamperBlocked = true;
  }
  const afterTamper = (await bSov.keymaster.resolveDID(statusListCredential)).didDocumentData as SignedStatusList;
  check('Archon refuses the non-Sovereign update', tamperBlocked);
  check('the list is unchanged (revoked bit still set)', getBit(decodeBitstring(afterTamper.encodedList), rec.statusListIndex));

  // ── INDEX-RANDOMNESS ──
  step('INDEX-RANDOMNESS: indices across a batch of issuances are NOT sequential (the privacy property)');
  const batch: number[] = [rec.statusListIndex, rec2.statusListIndex];
  for (let i = 0; i < 6; i++) {
    const r = await issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope, statusListCredential, registry: reg, assignedIndices: assigned });
    batch.push(r.statusListIndex);
  }
  const spread = Math.max(...batch) - Math.min(...batch);
  const sequential = batch.every((v, i) => i === 0 || v === batch[i - 1]! + 1);
  check(`${batch.length} indices are distinct`, new Set(batch).size === batch.length);
  check(`indices are NOT sequential (spread ${spread} ≫ ${batch.length}, not a consecutive run)`, !sequential && spread > 1_000);

  // ── HERD-SIZE ──
  step('HERD-SIZE: the published list is the W3C minimum length regardless of how many bits are set');
  const lenNow = decodeBitstring(((await bWarden.keymaster.resolveDID(statusListCredential)).didDocumentData as SignedStatusList).encodedList).length;
  check(`bitstring is the fixed ${STATUS_LIST_LENGTH}-bit minimum (${STATUS_LIST_BYTES} bytes), independent of set bits`, lenNow === STATUS_LIST_BYTES);
  // Setting more bits does not change the length.
  await publishRevocation(bSov, bSovId.name, statusListCredential, rec2.statusListIndex, cfgB);
  const lenAfter = decodeBitstring(((await bWarden.keymaster.resolveDID(statusListCredential)).didDocumentData as SignedStatusList).encodedList).length;
  check('bitstring length is unchanged after more revocations', lenAfter === STATUS_LIST_BYTES);

  process.stdout.write(
    failures === 0
      ? '\n✓ status list: durable (survives a fresh Warden), fail-closed, version-pinned + audit-replayable, controller-enforced, random-indexed, and fixed herd-size\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-status-list: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
