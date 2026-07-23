/**
 * e2e: Trusted-Knowledge Mesh — DEPTH-2 propagation, live against Archon.
 *
 * Nodes A (origin) → B (relay+friend) → C (answerer). A recognizes B; B recognizes C; A does NOT recognize
 * C. A query A's Emissary cannot answer at B is forwarded by B (via B's OWN Emissary, under B's OWN
 * recognition of C) to C; C's answer returns along the path, budget + depth + confidence attenuating each
 * hop. Verification (C's signature) is NOT recognition (A never recognizes C). A correct REJECT is a PASS.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-mesh-depth2.ts
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
  receiveForwardedAnswer,
  budgetSubset,
  type MeshQuery,
  type MeshQueryEnvelope,
  type MeshPolicy,
  type PublicPartition,
  type MeshForwarding,
  type MeshResult,
  type KeymasterHandle,
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const b = loadConfig();
  const pass = 'hearthold-mesh-d2';
  const reg = b.registry;
  const cfgA = { ...b, dataRoot: join(b.dataRoot, 'A') };
  const cfgB = { ...b, dataRoot: join(b.dataRoot, 'B') };
  const cfgC = { ...b, dataRoot: join(b.dataRoot, 'C') };

  step('Provision three nodes: A (Warden+Emissary), B (Sovereign+Warden+Emissary), C (Sovereign+Warden+Emissary)');
  const aWarden = await openKeymaster('warden', cfgA, pass);
  const aEmissary = await openKeymaster('emissary', cfgA, pass);
  const outsider = await openKeymaster('verifier', cfgA, pass);
  const bSov = await openKeymaster('sovereign', cfgB, pass);
  const bWarden = await openKeymaster('warden', cfgB, pass);
  const bEmissary = await openKeymaster('emissary', cfgB, pass);
  const cSov = await openKeymaster('sovereign', cfgC, pass);
  const cWarden = await openKeymaster('warden', cfgC, pass);
  const cEmissary = await openKeymaster('emissary', cfgC, pass);
  const aWardenId = await ensureIdentity(aWarden, cfgA);
  const aEmId = await ensureIdentity(aEmissary, cfgA);
  const outsiderId = await ensureIdentity(outsider, cfgA);
  const bSovId = await ensureIdentity(bSov, cfgB);
  const bWardenId = await ensureIdentity(bWarden, cfgB);
  const bEmId = await ensureIdentity(bEmissary, cfgB);
  const cSovId = await ensureIdentity(cSov, cfgC);
  const cWardenId = await ensureIdentity(cWarden, cfgC);
  const cEmId = await ensureIdentity(cEmissary, cfgC);
  check('three nodes provisioned', cWardenId.did.startsWith('did:') && cEmId.did.startsWith('did:'));

  step('Each Sovereign owns a Bitstring StatusList; issue recognitions: B←A (0.9,d2), B←A@d1, C←B (0.8,d2)');
  const bList = await createStatusList(bSov, bSovId.name, cfgB);
  const cList = await createStatusList(cSov, cSovId.name, cfgC);
  const bAlloc = await createAllocationRecord(bSov, bSovId.name, cfgB);
  const cAlloc = await createAllocationRecord(cSov, cSovId.name, cfgC);
  const recAB = await issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope: { tier: 'trusted', confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 2 }, statusListCredential: bList.statusListCredential, allocationRecord: bAlloc, registry: reg });
  const recAB_d1 = await issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope: { tier: 'trusted', confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 1 }, statusListCredential: bList.statusListCredential, allocationRecord: bAlloc, registry: reg });
  const recBC = await issueRecognition({ issuer: cSov, issuerName: cSovId.name, subject: bEmId.did, scope: { tier: 'trusted', confidence: 0.8, domain: 'fences', mode: 'fact', maxDepth: 2 }, statusListCredential: cList.statusListCredential, allocationRecord: cAlloc, registry: reg });
  check('recognitions issued (A←B, A←B@depth1, B←C)', recAB.recognitionId !== recBC.recognitionId);

  // Partitions: B does NOT hold the post-spacing fact (so B must forward); C does.
  const partB: PublicPartition = { domain: 'fences', facts: [{ ref: 'gate-latch', provenance: 'asserted', confidence: 1, keywords: ['gate', 'latch', 'hinge'], narrative: 'B: use self-closing hinges on a pool gate.' }] };
  const partC: PublicPartition = { domain: 'fences', facts: [{ ref: 'post-spacing', provenance: 'asserted', confidence: 1, keywords: ['post', 'spacing', 'apart', 'space'], narrative: 'Sovereign C asserts: set posts 8 feet on center, 2 feet deep in concrete.' }] };

  // Durable revocation is required — each Warden resolves the StatusList for the recognitions it honors.
  // Empty here: no revocations in this suite.
  const bStatus = new StatusListResolver(bWarden, { statusListCredential: bList.statusListCredential, expectedIssuer: bSovId.did, maxAgeMs: 60_000 });
  const cStatus = new StatusListResolver(cWarden, { statusListCredential: cList.statusListCredential, expectedIssuer: cSovId.did, maxAgeMs: 60_000 });
  const polB: MeshPolicy = { recognizedIssuer: bSovId.did, tier: 'trusted', maxArrivalDepth: 1, statusList: bStatus, maxRelayDepth: 1 };
  const polC: MeshPolicy = { recognizedIssuer: cSovId.did, tier: 'trusted', maxArrivalDepth: 1, statusList: cStatus, maxRelayDepth: 1 };

  // C's Warden (answerer). Give it a forwarding capability with NO friends so a query it can't answer hits
  // the depth-exhaustion stop (DEPTH-STOP) rather than a bare partition miss.
  const cForwarding: MeshForwarding = { emissary: cEmissary, emissaryName: cEmId.name, emissaryDid: cEmId.did, friends: [], reachFriend: async () => ({ status: 'no-answer', reason: 'C has no onward friend' }) };
  const meshC = new MeshWarden(cWarden, cWardenId.name, cfgC, polC, partC, cForwarding);

  // B's Warden (relay). Its Emissary crosses to C under B's recognition of C. reachFriend records the
  // forwarded envelope so we can inspect what C learns (QUERY-EXPOSURE).
  let forwardedToC: MeshQueryEnvelope | null = null;
  const reachC = async (friendWardenDid: string, env: MeshQueryEnvelope): Promise<MeshResult> => {
    forwardedToC = env;
    return meshC.handle(env);
  };
  const bForwarding: MeshForwarding = {
    emissary: bEmissary,
    emissaryName: bEmId.name,
    emissaryDid: bEmId.did,
    friends: [{ cred: recBC, recognitionId: recBC.recognitionId, confidence: 0.8, friendWardenDid: cWardenId.did, domain: 'fences' }],
    reachFriend: reachC,
  };
  const meshB = new MeshWarden(bWarden, bWardenId.name, cfgB, polB, partB, bForwarding);

  const q = (over: Partial<MeshQuery> = {}): MeshQuery => ({ text: 'how far apart should fence posts be?', mode: 'fact', domain: 'fences', depth: 1, budget: { maxNodes: 3, rate: 2 }, depthRemaining: 1, ...over });
  const env = (query: MeshQuery, rec = recAB): MeshQueryEnvelope => ({ query, recognition: presentRecognition(rec), presenterDid: aEmId.did });

  // ── HAPPY-2HOP ──
  step('HAPPY-2HOP: A→B→C answers; A verifies C\'s signature, sees composed confidence 0.72 + full path');
  const res = await meshB.handle(env(q()));
  check('B forwards, C answers, B returns a granted (encrypted) forwarded answer', res.status === 'granted');
  let happyDid = '';
  if (res.status === 'granted') {
    happyDid = res.answerDid;
    const recv = await receiveForwardedAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: res.answerDid, self: aEmId.did, expectedRelay: bWardenId.did, relayEdgeConfidence: 0.9 });
    check('A decrypts + verifies C\'s Warden signature (verification)', recv.ok && recv.verifiedSigner === cWardenId.did);
    check('composed path confidence = 0.9 × 0.8 = 0.72', Math.abs((recv.pathConfidence ?? 0) - 0.72) < 1e-9);
    check('full A→B→C provenance path assembled by the mesh', (recv.path?.length === 2) && recv.path![0].basis === 'A recognizes B' && recv.path![1].basis === 'B recognizes C');
    if (recv.ok) {
      process.stdout.write('    ── evidence graph (rendered) ──\n');
      process.stdout.write(`      reference:  ${recv.answer!.reference} (${recv.answer!.provenance} — C asserts, forwarded by B)\n`);
      process.stdout.write(`      path:       ${recv.path!.map((e) => `${e.from.slice(0, 10)}…→${e.to.slice(0, 10)}… [${e.basis} @${e.confidence}]`).join('  ')}\n`);
      process.stdout.write(`      confidence: ${recv.pathConfidence} (composed, ≤ each hop)\n`);
      process.stdout.write(`      narrative:  ${recv.answer!.narrative}\n`);
    }
  }

  // ── NON-TRANSITIVE-TRUST ──
  step('NON-TRANSITIVE-TRUST: C served because B recognizes C; A verifies C but does NOT recognize C');
  const recv2 = await receiveForwardedAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: happyDid, self: aEmId.did, expectedRelay: bWardenId.did, relayEdgeConfidence: 0.9 });
  check('A does NOT recognize the answerer (structural: recognizesAnswerer === false)', recv2.recognizesAnswerer === false);
  check('the C-edge is labeled "B recognizes C", never "A recognizes C"', !recv2.path!.some((e) => e.from === aEmId.did && e.to === cWardenId.did));
  check('A VERIFIED C\'s signature (verifiedSigner = C) — verification ≠ recognition', recv2.verifiedSigner === cWardenId.did && recv2.recognizedRelay === bWardenId.did);

  // ── CONFIDENCE-MONOTONICITY ──
  step('CONFIDENCE-MONOTONICITY: composed confidence strictly ≤ every single-hop confidence');
  check('0.72 ≤ min(0.9, 0.8) and ≤ each hop', (recv2.pathConfidence ?? 1) <= 0.8 && recv2.path!.every((e) => (recv2.pathConfidence ?? 1) <= e.confidence));

  // ── CONFIDENTIALITY-2HOP + QUERY-EXPOSURE ──
  step('CONFIDENTIALITY-2HOP: both return legs pairwise-encrypted; B (relay) learns the answer; 4th party learns nothing');
  // Leg C→B, obtained by presenting to C directly as B's Emissary would.
  const legCB = await meshC.handle({ query: q({ depthRemaining: 0 }), recognition: presentRecognition(recBC), presenterDid: bEmId.did });
  let legCBEnc = '';
  if (legCB.status === 'granted') legCBEnc = legCB.answerDid;
  let outsiderCB = false;
  try { await outsider.keymaster.setCurrentId(outsiderId.name); await outsider.keymaster.decryptJSON(legCBEnc); } catch { outsiderCB = true; }
  check('leg C→B: a 4th party cannot decrypt', outsiderCB);
  await bEmissary.keymaster.setCurrentId(bEmId.name);
  const bCanRead = await bEmissary.keymaster.decryptJSON(legCBEnc).then(() => true).catch(() => false);
  check('leg C→B: B (the relay) CAN decrypt — it learns the answer', bCanRead);
  let outsiderBA = false;
  try { await outsider.keymaster.setCurrentId(outsiderId.name); await outsider.keymaster.decryptJSON(happyDid); } catch { outsiderBA = true; }
  check('leg B→A: a 4th party cannot decrypt', outsiderBA);

  step('QUERY-EXPOSURE: prove what B and C each learn about A\'s query (the querier-privacy boundary)');
  check('B learns A\'s query text + A\'s identity (A presented directly to B)', forwardedToC !== null);
  check('C sees the query text (forwarded)', !!forwardedToC && forwardedToC.query.text.includes('post'));
  check('C is presented B\'s Emissary as the querier, NOT A\'s (querier A hidden from C)', !!forwardedToC && forwardedToC.presenterDid === bEmId.did);
  check('A\'s Emissary DID does NOT appear in the B→C envelope', !!forwardedToC && !JSON.stringify(forwardedToC).includes(aEmId.did));

  // ── RECOGNITION-DEPTH-BOUND ──
  step('RECOGNITION-DEPTH-BOUND: A\'s recognition authorizes maxDepth 1, but the query needs depth 2 → REJECT');
  const rDepthBound = await meshB.handle(env(q({ depthRemaining: 1 }), recAB_d1));
  check('B REJECTS: the recognition\'s own depth governs (not just partition policy)', rDepthBound.status === 'rejected' && rDepthBound.check === 'depth');
  if (rDepthBound.status === 'rejected') process.stdout.write(`      → ${rDepthBound.reason}\n`);

  // ── DEPTH-STOP ──
  step('DEPTH-STOP: at C (remaining 0) a query C can\'t answer → C cannot forward to D → REJECT');
  const rStop = await meshC.handle({ query: q({ text: 'what wood stain color is best?', depthRemaining: 0 }), recognition: presentRecognition(recBC), presenterDid: bEmId.did });
  check('C REJECTS the onward forward (propagation depth exhausted)', rStop.status === 'rejected' && rStop.check === 'depth');
  if (rStop.status === 'rejected') process.stdout.write(`      → ${rStop.reason}\n`);

  // ── BUDGET-ATTENUATION ──
  step('BUDGET-ATTENUATION: a forward whose budget/scope is NOT ⊆ the incoming grant → REJECT (the per-hop gate)');
  // The mesh calls budgetSubset(forward, incoming) before B ever crosses to C. A forward that broadens the
  // budget (maxNodes 5 > incoming 1) or the scope must be refused. Both broaden-attempts are rejected:
  const overBudget = budgetSubset(q({ budget: { maxNodes: 5, rate: 1 }, depthRemaining: 0 }), q({ budget: { maxNodes: 1, rate: 1 }, depthRemaining: 1 }));
  const overScope = budgetSubset(q({ mode: 'reasoning', depthRemaining: 0 }), q({ mode: 'fact', depthRemaining: 1 }));
  check('over-BUDGET forward rejected (maxNodes 5 ⊄ incoming 1)', !overBudget.ok);
  check('over-SCOPE forward rejected (mode:reasoning ⊄ incoming mode:fact)', !overScope.ok);
  process.stdout.write(`      → ${overBudget.reason}\n`);

  // ── BROKEN-RELAY-RECOGNITION ──
  step('BROKEN-RELAY-RECOGNITION: B lacks a valid recognition of C → clean no-answer (never a forged one)');
  const meshBNoFriend = new MeshWarden(bWarden, bWardenId.name, cfgB, polB, partB, { ...bForwarding, friends: [] });
  const rBroken = await meshBNoFriend.handle(env(q()));
  check('A gets a clean no-answer, not a fabricated answer', rBroken.status === 'no-answer');
  if (rBroken.status === 'no-answer') process.stdout.write(`      → ${rBroken.reason}\n`);

  // ── CYCLE ──
  step('CYCLE: forwarding to a node already on the path is detected and rejected');
  const rCycle = await meshB.handle(env(q({ visited: [cWardenId.did] })));
  check('B REJECTS a forward that would revisit a node already on the path', rCycle.status === 'rejected' && rCycle.check === 'cycle');
  if (rCycle.status === 'rejected') process.stdout.write(`      → ${rCycle.reason}\n`);

  // ── CONFIDENCE-BOUNDS ──
  step('CONFIDENCE-BOUNDS: a recognized-but-dishonest relay reporting edgeConfidence 1.2 → REJECT (bounds guard)');
  // B is genuinely recognized, but signs a relay assertion claiming an edge confidence > 1 — which would
  // amplify path confidence above the A→B edge and break monotonicity. A's bounds check must refuse it.
  const meshBBadConf = new MeshWarden(bWarden, bWardenId.name, cfgB, polB, partB, {
    ...bForwarding,
    friends: [{ cred: recBC, recognitionId: recBC.recognitionId, confidence: 1.2, friendWardenDid: cWardenId.did, domain: 'fences' }],
  });
  const badRes = await meshBBadConf.handle(env(q()));
  let boundsRejected = false;
  let boundsReason = '';
  if (badRes.status === 'granted') {
    const rBad = await receiveForwardedAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: badRes.answerDid, self: aEmId.did, expectedRelay: bWardenId.did, relayEdgeConfidence: 0.9 });
    boundsRejected = !rBad.ok && rBad.check === 'confidence';
    boundsReason = rBad.reason ?? '';
  }
  check('A REJECTS a relay assertion whose edgeConfidence > 1 (a relay cannot amplify path confidence)', boundsRejected);
  if (boundsRejected) process.stdout.write(`      → ${boundsReason}\n`);
  const rBadCaller = await receiveForwardedAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: happyDid, self: aEmId.did, expectedRelay: bWardenId.did, relayEdgeConfidence: 1.2 });
  check('A REJECTS an out-of-range caller-supplied relayEdgeConfidence (1.2)', !rBadCaller.ok && rBadCaller.check === 'confidence');

  process.stdout.write(
    failures === 0
      ? '\n✓ mesh depth-2: A→B→C answers with composed confidence + full path provenance; budget, depth, and confidence all attenuate; verification ≠ recognition\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-mesh-depth2: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
