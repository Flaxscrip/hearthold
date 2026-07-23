/**
 * e2e: the partition ladder — TWO INDEPENDENT axes (recognition tier AND arrival depth), both ANDed.
 *
 * A three-rung fence-builder ladder — world-public → acquaintance → close-friend — each rung gated on
 * BOTH the presenter's tier AND how many hops the query travelled to reach us. "Reached me through trusted
 * hops" (depth) must never silently become "I trust them" (tier). Deny by default; reasoning is sandboxed
 * to the permitted rungs. A correct no-answer is a PASS. Run:
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-partition-ladder.ts
 *
 * Matrix: WORLD-PUBLIC · TIER-GATING · DEPTH-GATING · AXIS-INDEPENDENCE · SANDBOXING · INDISTINGUISHABILITY · LADDER-ORDER.
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  issueRecognition,
  presentRecognition,
  createStatusList,
  createAllocationRecord,
  StatusListResolver,
  MeshWarden,
  receiveAnswer,
  permittedPartitions,
  type MeshPolicy,
  type MeshQuery,
  type MeshQueryEnvelope,
  type PartitionLadder,
  type IssuedDisclosureCredential,
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-ladder-e2e';
  const reg = base.registry;
  const cfgA = { ...base, dataRoot: join(base.dataRoot, 'A') };
  const cfgB = { ...base, dataRoot: join(base.dataRoot, 'B') };

  step('Provision B (Sovereign + Warden) and A (Emissary/presenter)');
  const aEmissary = await openKeymaster('emissary', cfgA, pass);
  const bSov = await openKeymaster('sovereign', cfgB, pass);
  const bWarden = await openKeymaster('warden', cfgB, pass);
  const aEmId = await ensureIdentity(aEmissary, cfgA);
  const bSovId = await ensureIdentity(bSov, cfgB);
  const bWardenId = await ensureIdentity(bWarden, cfgB);
  const { statusListCredential } = await createStatusList(bSov, bSovId.name, cfgB);
  const allocationRecord = await createAllocationRecord(bSov, bSovId.name, cfgB);

  // ── The demo: a realistic three-rung ladder ──
  const tierOrder = ['world', 'acquaintance', 'close-friend'];
  const ladder: PartitionLadder = [
    { name: 'world-public', domain: 'fences', access: { minTier: 'world', maxArrivalDepth: 2 }, facts: [{ ref: 'post-spacing', provenance: 'asserted', confidence: 1, keywords: ['post', 'spacing', 'apart'], narrative: 'General fence advice: set posts 8 feet on center.' }] },
    { name: 'acquaintance', domain: 'fences', access: { minTier: 'acquaintance', maxArrivalDepth: 2 }, facts: [{ ref: 'contractor-rate', provenance: 'asserted', confidence: 0.9, keywords: ['contractor', 'rate', 'charge', 'cost'], narrative: 'My fence contractor charges about $45 per linear foot.' }] },
    { name: 'close-friend', domain: 'fences', access: { minTier: 'close-friend', maxArrivalDepth: 1 }, facts: [{ ref: 'gate-code', provenance: 'asserted', confidence: 1, keywords: ['gate', 'code', 'combination'], narrative: 'The side gate code is 4-8-1-5.' }] },
  ];
  step('B\'s three-rung ladder: world-public (tier world, depth ≤2) · acquaintance (acquaintance, ≤2) · close-friend (close-friend, depth 1 only)');
  process.stdout.write('    world-public → "set posts 8ft on center"   acquaintance → "$45/linear foot"   close-friend → "gate code 4-8-1-5"\n');

  const statusList = new StatusListResolver(bWarden, { statusListCredential, expectedIssuer: bSovId.did, maxAgeMs: 60_000 });
  const policy: MeshPolicy = { recognizedIssuer: bSovId.did, tierOrder, statusList };
  const meshB = new MeshWarden(bWarden, bWardenId.name, cfgB, policy, ladder);

  const recAt = (tier: string): Promise<IssuedDisclosureCredential & { recognitionId: string }> =>
    issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope: { tier, confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 2 }, statusListCredential, allocationRecord, registry: reg });
  const recWorld = await recAt('world');
  const recAcq = await recAt('acquaintance');
  const recClose = await recAt('close-friend');

  const Q = { post: 'how far apart should fence posts be?', rate: 'what does your contractor charge?', gate: 'what is the gate code?', miss: 'what paint colour is best?' };
  const q = (text: string, arrivalDepth = 1): MeshQuery => ({ text, mode: 'fact', domain: 'fences', budget: { maxNodes: 1, rate: 1 }, arrivalDepth });
  const ask = (rec: IssuedDisclosureCredential, text: string, arrivalDepth = 1): Promise<ReturnType<MeshWarden['handle']> extends Promise<infer R> ? R : never> =>
    meshB.handle({ query: q(text, arrivalDepth), recognition: presentRecognition(rec), presenterDid: aEmId.did } as MeshQueryEnvelope);
  const reference = async (res: Awaited<ReturnType<MeshWarden['handle']>>): Promise<string | null> => {
    if (res.status !== 'granted') return null;
    const r = await receiveAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: res.answerDid, expectedIssuer: bWardenId.did });
    return r.answer?.reference ?? null;
  };

  // ── WORLD-PUBLIC ──
  step('WORLD-PUBLIC: a minimally-recognized (world) presenter reaches world-public and NOTHING above it');
  check('world presenter gets the world-public fact', (await reference(await ask(recWorld, Q.post))) === 'post-spacing');
  check('world presenter is DENIED the acquaintance fact (no-answer)', (await ask(recWorld, Q.rate)).status === 'no-answer');
  check('world presenter is DENIED the close-friend fact (no-answer)', (await ask(recWorld, Q.gate)).status === 'no-answer');

  // ── TIER-GATING ──
  step('TIER-GATING: a low-tier presenter asking a question that MATCHES a higher-tier fact does not receive it');
  check('acquaintance CAN reach the acquaintance fact', (await reference(await ask(recAcq, Q.rate))) === 'contractor-rate');
  check('acquaintance is DENIED the close-friend fact even though the query matches it', (await ask(recAcq, Q.gate)).status === 'no-answer');

  // ── DEPTH-GATING ──
  step('DEPTH-GATING: a HIGH-tier (close-friend) presenter arriving at depth 2 cannot reach a depth-1-only rung');
  check('close-friend at depth 1 gets the gate code', (await reference(await ask(recClose, Q.gate, 1))) === 'gate-code');
  check('close-friend at depth 2 is DENIED (the rung is depth-1-only)', (await ask(recClose, Q.gate, 2)).status === 'no-answer');

  // ── AXIS-INDEPENDENCE ──
  step('AXIS-INDEPENDENCE: for the SAME close-friend rung, high-tier-but-too-deep AND low-tier-but-shallow are BOTH denied');
  check('high tier + too deep (close-friend @ depth 2) → denied', (await ask(recClose, Q.gate, 2)).status === 'no-answer');
  check('low tier + depth 1 (acquaintance @ depth 1) → denied', (await ask(recAcq, Q.gate, 1)).status === 'no-answer');
  check('only both-axes-satisfied (close-friend @ depth 1) is granted', (await ask(recClose, Q.gate, 1)).status === 'granted');

  // ── SANDBOXING ──
  step('SANDBOXING: the answer\'s content comes ONLY from a permitted rung — a gated rung\'s fact never leaks');
  const worldAnswerRef = await reference(await ask(recWorld, Q.post));
  check('world presenter\'s answer is the world-public fact, not any gated one', worldAnswerRef === 'post-spacing');
  check('the close-friend fact is unreachable to a world presenter (no leakage)', (await ask(recWorld, Q.gate)).status === 'no-answer');

  // ── INDISTINGUISHABILITY ──
  step('INDISTINGUISHABILITY: a query that HITS a gated rung and one that matches NOTHING give the identical response');
  const gatedHit = await ask(recWorld, Q.gate); // matches close-friend, but world can't reach it
  const genuineMiss = await ask(recWorld, Q.miss); // matches nothing anywhere
  check('both are no-answer', gatedHit.status === 'no-answer' && genuineMiss.status === 'no-answer');
  check('the responses are byte-identical (no-answer is not an oracle for gated contents)', JSON.stringify(gatedHit) === JSON.stringify(genuineMiss));

  // ── LADDER-ORDER ──
  step('LADDER-ORDER: tier ranking is EXPLICIT — inserting a tier in the middle does not silently re-rank the others');
  const tierOrder2 = ['world', 'acquaintance', 'colleague', 'close-friend']; // colleague inserted between
  const reach = (tier: string, depth: number): string[] => permittedPartitions(ladder, tierOrder2, tier, depth, 0.9).map((p) => p.name);
  check('close-friend still reaches its rung after the insertion (rank preserved above acquaintance)', reach('close-friend', 1).includes('close-friend'));
  check('the newly-inserted colleague reaches world-public + acquaintance but NOT close-friend', JSON.stringify(reach('colleague', 1).sort()) === JSON.stringify(['acquaintance', 'world-public']));
  check('explicit ranks, not string compare: index(close-friend) > index(acquaintance) in both orderings', tierOrder2.indexOf('close-friend') > tierOrder2.indexOf('acquaintance') && tierOrder.indexOf('close-friend') > tierOrder.indexOf('acquaintance'));

  process.stdout.write(
    failures === 0
      ? '\n✓ partition ladder: two independent axes (tier ∧ arrival-depth), deny-by-default, sandboxed, indistinguishable, explicitly ranked\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-partition-ladder: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
