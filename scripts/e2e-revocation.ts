/**
 * e2e: durable, verifiable recognition revocation — a RevocationList as an Archon asset, live.
 *
 * Replaces the in-memory Set with a Sovereign-owned, version-pinned, signed list. A correct REJECT is a
 * PASS; the checker is never loosened. Run:
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-revocation.ts
 *
 * Matrix: HAPPY · REVOKED-PUBLISHED · PERSISTENCE · FAIL-CLOSED · STALENESS · AUDIT-REPLAY ·
 *         CONTROLLER-TAMPER · PRIVACY.
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  issueRecognition,
  presentRecognition,
  createRevocationList,
  publishRevocation,
  auditRevocationAt,
  RevocationResolver,
  MeshWarden,
  receiveAnswer,
  type MeshPolicy,
  type MeshQuery,
  type MeshQueryEnvelope,
  type PublicPartition,
  type SignedRevocationList,
  type RevocationListPin,
  type KeymasterHandle,
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-revocation-e2e';
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

  step('B\'s Sovereign creates a RevocationList asset (its own DID) + recognizes A');
  const { listDid } = await createRevocationList(bSov, bSovId.name, cfgB);
  const rec = await issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope: { tier: 'trusted', confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 1 }, registry: reg });
  const rec2 = await issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope: { tier: 'trusted', confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 1 }, registry: reg });
  check('RevocationList + recognition issued', listDid.startsWith('did:') && rec.recognitionId.length > 0);

  const partition: PublicPartition = { domain: 'fences', facts: [{ ref: 'post-spacing', provenance: 'asserted', confidence: 1, keywords: ['post', 'spacing', 'apart'], narrative: 'Sovereign B asserts: set posts 8 feet on center.' }] };
  const query: MeshQuery = { text: 'how far apart should fence posts be?', mode: 'fact', domain: 'fences', depth: 1, budget: { maxNodes: 3, rate: 2 } };
  const envOf = (r = rec): MeshQueryEnvelope => ({ query, recognition: presentRecognition(r), presenterDid: aEmId.did });
  const policyWith = (resolver: RevocationResolver): MeshPolicy => ({ recognizedIssuer: bSovId.did, tier: 'trusted', maxArrivalDepth: 1, revocation: resolver });

  // Live resolver (maxAge 0 ⇒ always re-resolves, so a publish is seen at once).
  const liveResolver = new RevocationResolver(bWarden, { listDid, expectedIssuer: bSovId.did, maxAgeMs: 0 });
  const meshB = new MeshWarden(bWarden, bWardenId.name, cfgB, policyWith(liveResolver), partition);

  // ── HAPPY ──
  step('HAPPY: unrevoked recognition → ACCEPT; the answer carries revocationCheckedAt + a pinned list version');
  const res = await meshB.handle(envOf());
  check('B admits + answers', res.status === 'granted');
  let happyPin: RevocationListPin | undefined;
  if (res.status === 'granted') {
    const recv = await receiveAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: res.answerDid, expectedIssuer: bWardenId.did });
    happyPin = recv.answer?.revocationListVersion;
    check('answer carries revocationCheckedAt', !!recv.answer?.revocationCheckedAt);
    check('answer carries a pinned list version (versionSequence + versionId)', !!happyPin && happyPin.versionSequence > 0 && happyPin.versionId.length > 0);
    process.stdout.write(`      pinned list: seq ${happyPin?.versionSequence} versionId ${happyPin?.versionId.slice(0, 20)}…\n`);
  }

  // ── AUDIT-REPLAY (before revocation) ──
  step('AUDIT-REPLAY (pre): resolve the answer\'s pinned version → recognitionId was ABSENT + versionId matches');
  const auditBefore = await auditRevocationAt(bWarden, happyPin!, rec.recognitionId);
  check('pinned version resolves and its versionId matches the answer', auditBefore.versionIdMatches);
  check('the recognition was NOT revoked at answer time', auditBefore.revokedThen === false);

  // ── REVOKED-PUBLISHED ──
  step('REVOKED-PUBLISHED: Sovereign publishes a revocation → next admission REJECTS');
  const pub = await publishRevocation(bSov, bSovId.name, listDid, rec.recognitionId, cfgB);
  check('revocation published (new list version)', pub.alreadyRevoked === false && pub.pin.versionSequence > (happyPin?.versionSequence ?? 0));
  const resRevoked = await meshB.handle(envOf());
  check('B REJECTS the now-revoked recognition', resRevoked.status === 'rejected' && resRevoked.check === 'revocation');
  if (resRevoked.status === 'rejected') process.stdout.write(`      → ${resRevoked.reason}\n`);
  // idempotent: revoking again is not an error and mints no new version.
  const pub2 = await publishRevocation(bSov, bSovId.name, listDid, rec.recognitionId, cfgB);
  check('revoking twice is idempotent (no new version)', pub2.alreadyRevoked === true && pub2.pin.versionSequence === pub.pin.versionSequence);

  // ── AUDIT-REPLAY (after revocation) ──
  step('AUDIT-REPLAY (post): current list contains it; the pinned HISTORICAL version still does NOT');
  const currentDoc = (await bWarden.keymaster.resolveDID(listDid)).didDocumentData as SignedRevocationList;
  check('the CURRENT list contains the recognitionId', currentDoc.entries.some((e) => e.recognitionId === rec.recognitionId));
  const auditAfter = await auditRevocationAt(bWarden, happyPin!, rec.recognitionId);
  check('the pinned historical version STILL shows it absent (immutable history)', auditAfter.versionIdMatches && auditAfter.revokedThen === false);

  // ── PERSISTENCE (the test the in-memory Set fails) ──
  step('PERSISTENCE: a FRESH Warden with NO in-memory state → still REJECTS the revoked recognition');
  const freshResolver = new RevocationResolver(bWarden, { listDid, expectedIssuer: bSovId.did, maxAgeMs: 60_000 });
  const freshMeshB = new MeshWarden(bWarden, bWardenId.name, cfgB, policyWith(freshResolver), partition);
  const resFresh = await freshMeshB.handle(envOf());
  check('durable: a brand-new Warden reads the published list and REJECTS', resFresh.status === 'rejected' && resFresh.check === 'revocation');

  // ── FAIL-CLOSED ──
  step('FAIL-CLOSED: an unresolvable list → DENY (never allow), even for an unrevoked recognition');
  const badResolver = new RevocationResolver(bWarden, { listDid: 'did:cid:bagaaieranotarealrevocationlist0000000000000000000000000000', expectedIssuer: bSovId.did, maxAgeMs: 60_000 });
  const badMeshB = new MeshWarden(bWarden, bWardenId.name, cfgB, policyWith(badResolver), partition);
  const resFailClosed = await badMeshB.handle(envOf(rec2)); // rec2 is NOT revoked — still denied because the fact is unavailable
  check('an unresolvable revocation list DENIES (fail-closed), never allows', resFailClosed.status === 'rejected' && resFailClosed.check === 'revocation');
  if (resFailClosed.status === 'rejected') process.stdout.write(`      → ${resFailClosed.reason}\n`);

  // ── STALENESS ──
  step('STALENESS: cached list older than maxRevocationAge + re-resolution fails → REJECT');
  const validList = (await bWarden.keymaster.resolveDID(listDid)).didDocumentData as SignedRevocationList;
  const validPin: RevocationListPin = { listDid, versionSequence: pub.pin.versionSequence, versionId: pub.pin.versionId, checkedAt: new Date().toISOString() };
  const fixedNow = 1_000_000;
  const staleResolver = new RevocationResolver(bWarden, { listDid: 'did:cid:bagaaieranotarealrevocationlist0000000000000000000000000000', expectedIssuer: bSovId.did, maxAgeMs: 1_000, clock: () => fixedNow });
  staleResolver.primeCache(validList, validPin, fixedNow - 5_000); // cached 5s ago, maxAge 1s ⇒ stale
  const staleMeshB = new MeshWarden(bWarden, bWardenId.name, cfgB, policyWith(staleResolver), partition);
  const resStale = await staleMeshB.handle(envOf(rec2));
  check('a stale cache whose re-resolution fails DENIES (fail-closed)', resStale.status === 'rejected' && resStale.check === 'revocation');

  // ── CONTROLLER-TAMPER ──
  step('CONTROLLER-TAMPER: a non-Sovereign attempts to update the list → refused by Archon\'s controller model');
  await bWarden.keymaster.setCurrentId(bWardenId.name); // B's Warden is NOT the list owner (B's Sovereign is)
  let tamperBlocked = false;
  try {
    tamperBlocked = !(await bWarden.keymaster.mergeData(listDid, { entries: [{ recognitionId: 'forged-by-warden', revokedAt: new Date().toISOString() }] }));
  } catch {
    tamperBlocked = true;
  }
  const afterTamper = ((await bSov.keymaster.resolveDID(listDid)).didDocumentData as SignedRevocationList).entries.map((e) => e.recognitionId);
  check('Archon refuses the non-Sovereign update', tamperBlocked);
  check('the list is unchanged (no forged entry)', !afterTamper.includes('forged-by-warden'));

  // ── PRIVACY ──
  step('PRIVACY: the published list holds ONLY opaque recognitionIds — no holder/Emissary DIDs, no domains');
  const listJson = JSON.stringify((await bWarden.keymaster.resolveDID(listDid)).didDocumentData);
  check('no holder/Emissary DID appears in the list', !listJson.includes(aEmId.did));
  check('no domain appears in the list', !listJson.includes('fences'));
  check('the recognitionId IS present (the only cross-referenced value, and it is opaque)', listJson.includes(rec.recognitionId));

  process.stdout.write(
    failures === 0
      ? '\n✓ revocation: durable (survives a fresh Warden), fail-closed, version-pinned + audit-replayable, controller-enforced, and privacy-scoped\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-revocation: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
