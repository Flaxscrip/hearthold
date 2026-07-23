/**
 * e2e: durable, collision-free status-list index allocation — a sealed AllocationRecord asset, live.
 *
 * Random assignment with no persistent record hits birthday collisions (~14% by 200 issued over 131,072
 * slots), silently sharing a bit between two recognitions. This proves the sealed record allocates uniquely,
 * durably (across a fresh issuer), safely under concurrency, and errors — never reuses — on exhaustion. A
 * correct REJECT/error is a PASS. Run:
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-allocation.ts
 *
 * Matrix: NO-COLLISION · RESTART-SAFETY · CONCURRENCY · SEALED · REVOKE-BY-ID · EXHAUSTION · INDEX-RANDOMNESS.
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createStatusList,
  createAllocationRecord,
  allocateIndex,
  lookupIndex,
  publishRevocation,
  issueRecognition,
  decodeBitstring,
  getBit,
  unsealAsWarden,
  STATUS_LIST_LENGTH,
  type SignedStatusList,
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-allocation-e2e';
  const reg = base.registry;
  const cfg = { ...base, dataRoot: join(base.dataRoot, 'S') };
  const cfgX = { ...base, dataRoot: join(base.dataRoot, 'X') };

  step('Provision: the issuing Sovereign + a third-party observer');
  const sov = await openKeymaster('sovereign', cfg, pass);
  const outsider = await openKeymaster('verifier', cfgX, pass);
  const sovId = await ensureIdentity(sov, cfg);
  await ensureIdentity(outsider, cfgX);
  const alloc = await createAllocationRecord(sov, sovId.name, cfg);
  const { statusListCredential } = await createStatusList(sov, sovId.name, cfg);
  check('sealed AllocationRecord + StatusList created', alloc.startsWith('did:') && statusListCredential.startsWith('did:'));

  // ── NO-COLLISION ──
  // 120 indices in a CONSTRAINED 150-slot space: random-without-a-record would collide with ~100% certainty
  // (birthday: 1 − e^(−120²/(2·150)) ≈ 1). The durable record makes every one distinct — the property the
  // old code could not guarantee. (At the real 131,072-slot scale, ~14% odds by 200; see FINDINGS.)
  step('NO-COLLISION: allocate 120 indices in a 150-slot space (random would ~certainly collide) → all unique');
  const NC_SPACE = 150;
  const indices: number[] = [];
  for (let i = 0; i < 120; i++) {
    const { index } = await allocateIndex(sov, sovId.name, alloc, `rec-${i}`, NC_SPACE);
    indices.push(index);
  }
  check('all 120 allocated indices are distinct (where random-without-a-record would collide)', new Set(indices).size === 120);

  // ── INDEX-RANDOMNESS ──
  step('INDEX-RANDOMNESS: allocation over the full space is non-sequential (privacy property preserved)');
  const randRecord = await createAllocationRecord(sov, sovId.name, cfg);
  const randIdx: number[] = [];
  for (let i = 0; i < 8; i++) randIdx.push((await allocateIndex(sov, sovId.name, randRecord, `r-${i}`, STATUS_LIST_LENGTH)).index);
  const spread = Math.max(...randIdx) - Math.min(...randIdx);
  const sequential = randIdx.every((v, i) => i === 0 || v === randIdx[i - 1]! + 1);
  check(`indices span ~${spread} of ${STATUS_LIST_LENGTH}, distinct, and not a consecutive run`, !sequential && spread > 10_000 && new Set(randIdx).size === randIdx.length);

  // ── RESTART-SAFETY ──
  step('RESTART-SAFETY: discard all in-memory state, a FRESH issuer allocates more → no collision with the earlier batch');
  const before = new Set(indices);
  const sov2 = await openKeymaster('sovereign', cfg, pass); // brand-new handle, no cached record
  await ensureIdentity(sov2, cfg);
  const later: number[] = [];
  for (let i = 0; i < 10; i++) {
    const { index } = await allocateIndex(sov2, sovId.name, alloc, `restart-${i}`, NC_SPACE);
    later.push(index);
  }
  check('the fresh issuer read the durable record and collided with NONE of the earlier indices', later.every((i) => !before.has(i)) && new Set(later).size === 10);

  // ── CONCURRENCY ──
  step('CONCURRENCY: two allocations race the same record version → one retries on the conflict, both distinct');
  let racyIndex = -1;
  const r1 = await allocateIndex(sov, sovId.name, alloc, 'race-1', STATUS_LIST_LENGTH, {
    // While race-1 holds version N, land race-2 first so race-1's CAS sees the conflict and retries.
    beforeWrite: async () => {
      racyIndex = (await allocateIndex(sov, sovId.name, alloc, 'race-2', STATUS_LIST_LENGTH)).index;
    },
  });
  check('the racing allocation retried on the version conflict (attempts > 1)', r1.attempts > 1);
  check('both allocations ended with distinct indices — neither silently overwrote the other', r1.index !== racyIndex && racyIndex >= 0);

  // ── SEALED ──
  step('SEALED: a third party cannot read the allocation record; no recognitionId or index in its cleartext');
  const doc = await outsider.keymaster.resolveDID(alloc);
  const sealed = (doc.didDocumentData as { sealed?: string }).sealed ?? '';
  let outsiderBlocked = false;
  try {
    await unsealAsWarden(outsider, sealed);
  } catch {
    outsiderBlocked = true;
  }
  check('a third party resolving the record cannot decrypt it', outsiderBlocked);
  const cleartext = JSON.stringify(doc.didDocumentData);
  check('the record cleartext contains no recognitionId and no allocated index', !cleartext.includes('rec-0') && !cleartext.includes(`:${indices[0]}`) && cleartext.includes('sealed'));

  // ── REVOKE-BY-ID ──
  step('REVOKE-BY-ID: publishRevocation(recognitionId) sets the CORRECT bit (the one the record holds)');
  const recognition = await issueRecognition({ issuer: sov, issuerName: sovId.name, subject: sovId.did, scope: { tier: 'trusted', confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 1 }, statusListCredential, allocationRecord: alloc, registry: reg });
  const recIndex = await lookupIndex(sov, sovId.name, alloc, recognition.recognitionId);
  await publishRevocation(sov, sovId.name, statusListCredential, recognition.recognitionId, alloc, cfg);
  const list = (await sov.keymaster.resolveDID(statusListCredential)).didDocumentData as SignedStatusList;
  check('the record resolved recognitionId → index', recIndex === recognition.statusListIndex && recIndex !== null);
  check('the bit at the record\'s index is set (revoked)', getBit(decodeBitstring(list.encodedList), recognition.statusListIndex));

  // ── EXHAUSTION ──
  step('EXHAUSTION: a full space produces a clear error, never a silent reuse');
  const tiny = await createAllocationRecord(sov, sovId.name, cfg);
  const SPACE = 4;
  const tinyIdx: number[] = [];
  for (let i = 0; i < SPACE; i++) tinyIdx.push((await allocateIndex(sov, sovId.name, tiny, `x-${i}`, SPACE)).index);
  check(`filled a ${SPACE}-slot space with ${SPACE} distinct indices`, new Set(tinyIdx).size === SPACE);
  let exhausted = false;
  let exhErr = '';
  try {
    await allocateIndex(sov, sovId.name, tiny, 'x-overflow', SPACE);
  } catch (e) {
    exhausted = true;
    exhErr = e instanceof Error ? e.message : String(e);
  }
  check('the next allocation throws a clear exhaustion error (no reuse)', exhausted && /exhausted/.test(exhErr));
  if (exhausted) process.stdout.write(`      → ${exhErr}\n`);

  process.stdout.write(
    failures === 0
      ? '\n✓ allocation: unique across the batch, durable across a fresh issuer, concurrency-safe, sealed, revoke-by-id, and errors (never reuses) on exhaustion\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-allocation: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
