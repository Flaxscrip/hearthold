/**
 * e2e: Trusted-Knowledge Mesh v1 — the fence-builder loop across two local nodes, live against Archon.
 *
 * Node A (me) = Warden + Emissary; node B (friend) = Sovereign + Warden. B's Sovereign recognizes A's
 * Emissary; A's Warden delegates a budgeted query (attenuation) to A's Emissary; A's Emissary hops to B's
 * Warden, which admits, reasons over its public partition, and returns a SIGNED, PAIRWISE-ENCRYPTED
 * evidence graph. A correct REJECT is a PASS; admission/verification are never loosened to go green.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-mesh.ts
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  issueVc,
  verifyAttenuationChain,
  issueRecognition,
  presentRecognition,
  createRevocationList,
  publishRevocation,
  RevocationResolver,
  delegatedScope,
  scopeQueryToDelegation,
  MeshWarden,
  receiveAnswer,
  type MeshQuery,
  type MeshQueryEnvelope,
  type MeshPolicy,
  type PublicPartition,
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
  const pass = 'hearthold-mesh-e2e';
  const reg = base.registry;
  const configA = { ...base, dataRoot: join(base.dataRoot, 'A') };
  const configB = { ...base, dataRoot: join(base.dataRoot, 'B') };

  step('Provision two nodes: A = Warden + Emissary, B = Sovereign + Warden (+ an outside observer)');
  const aWarden = await openKeymaster('warden', configA, pass);
  const aEmissary = await openKeymaster('emissary', configA, pass);
  const bSov = await openKeymaster('sovereign', configB, pass);
  const bWarden = await openKeymaster('warden', configB, pass);
  const outsider = await openKeymaster('verifier', configA, pass); // a third party on the wire
  const aWardenId = await ensureIdentity(aWarden, configA);
  const aEmId = await ensureIdentity(aEmissary, configA);
  const bSovId = await ensureIdentity(bSov, configB);
  const bWardenId = await ensureIdentity(bWarden, configB);
  const outsiderId = await ensureIdentity(outsider, configA);
  check('both nodes provisioned', aEmId.did.startsWith('did:') && bWardenId.did.startsWith('did:'));

  step('B\'s Sovereign RECOGNIZES A\'s Emissary (selective-disclosure VC, scoped, revocable)');
  const recognition = await issueRecognition({
    issuer: bSov,
    issuerName: bSovId.name,
    subject: aEmId.did,
    scope: { tier: 'trusted', confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 1 },
    registry: reg,
  });
  check('recognition issued by B\'s Sovereign, naming A\'s Emissary', recognition.recognitionId.length > 0);

  step('A\'s Warden DELEGATES a budgeted query to A\'s Emissary (attenuation credential)');
  const delegated = delegatedScope(['fences'], ['fact']);
  const delegatedBudget = { maxNodes: 10, rate: 5 };
  const delegation = await issueVc({ issuer: aWarden, issuerName: aWardenId.name, holder: aEmId.did, authoritySet: delegated, registry: reg });
  const chain = await verifyAttenuationChain(delegation.vcDid, { keymaster: aWarden as KeymasterHandle, expectedRootIssuer: aWardenId.did });
  check('the delegation is a valid attenuation credential from A\'s Warden', chain.ok);

  // B's public partition (a seeded fence-builder note) + admission policy.
  const partition: PublicPartition = {
    domain: 'fences',
    facts: [
      { ref: 'post-spacing', provenance: 'asserted', confidence: 1.0, keywords: ['post', 'spacing', 'apart', 'space'], narrative: 'Sovereign B asserts: set posts 8 feet on center for a cedar privacy fence, 2 feet deep in concrete.' },
      { ref: 'concrete-cure', provenance: 'inferred', confidence: 0.65, keywords: ['concrete', 'cure', 'set'], narrative: "B's AI inferred from B's notes: concrete usually cures enough to hang panels in 24-48 hours." },
    ],
  };
  // Durable revocation is required — B's Sovereign owns an (initially empty) RevocationList; B's Warden
  // resolves it (maxAge 0 ⇒ a later publish is seen at once).
  const { listDid } = await createRevocationList(bSov, bSovId.name, configB);
  const revocation = new RevocationResolver(bWarden, { listDid, expectedIssuer: bSovId.did, maxAgeMs: 0 });
  const policy: MeshPolicy = { recognizedIssuer: bSovId.did, tier: 'trusted', maxArrivalDepth: 1, revocation };
  const meshB = new MeshWarden(bWarden, bWardenId.name, configB, policy, partition);

  const validQuery: MeshQuery = { text: 'how far apart should fence posts be?', mode: 'fact', domain: 'fences', depth: 1, budget: { maxNodes: 3, rate: 2 } };
  const envelopeOf = (q: MeshQuery, rec = recognition): MeshQueryEnvelope => ({ query: q, recognition: presentRecognition(rec), presenterDid: aEmId.did });

  // ── HAPPY ──
  step('HAPPY: valid recognition, depth 1 → ACCEPT, evidence graph returns, A verifies + decrypts');
  const aScope = scopeQueryToDelegation(validQuery, delegated, delegatedBudget);
  check('A-side: the query is within the delegated budget/scope', aScope.ok);
  const res = await meshB.handle(envelopeOf(validQuery));
  check('B admits + returns an encrypted evidence graph', res.status === 'granted');
  let happyAnswerDid = '';
  if (res.status === 'granted') {
    happyAnswerDid = res.answerDid;
    const recv = await receiveAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: res.answerDid, expectedIssuer: bWardenId.did });
    check('A decrypts + verifies B\'s Warden signature', recv.ok);
    check('provenance tag present + signed', recv.answer?.provenance === 'asserted');
    if (recv.answer) {
      process.stdout.write('    ── evidence graph (rendered) ──\n');
      process.stdout.write(`      reference:  ${recv.answer.reference}\n`);
      process.stdout.write(`      provenance: ${recv.answer.provenance} (fact ${recv.answer.factConfidence}, recognition-path ${recv.answer.recognitionConfidence})\n`);
      process.stdout.write(`      narrative:  ${recv.answer.narrative}\n`);
      process.stdout.write(`      answeredBy: ${recv.answer.answeredBy.slice(0, 30)}… (B's Warden)\n`);
    }
  }

  // ── CONFIDENTIALITY ──
  step('CONFIDENTIALITY: the answer on the wire is pairwise-encrypted — a third party learns nothing');
  let outsiderBlocked = false;
  try {
    await outsider.keymaster.setCurrentId(outsiderId.name);
    await outsider.keymaster.decryptJSON(happyAnswerDid);
  } catch {
    outsiderBlocked = true;
  }
  check('a third party cannot decrypt the answer', outsiderBlocked);
  const wireClear = JSON.stringify((await outsider.keymaster.resolveDID(happyAnswerDid)).didDocumentData);
  check('the answer narrative is NOT in the wire cleartext (only cipher_* is)', !wireClear.includes('8 feet on center') && wireClear.includes('cipher_'));

  // ── PROVENANCE-INTEGRITY ──
  step('PROVENANCE-INTEGRITY: the signed provenance tag cannot be forged/altered by A after receipt');
  const recvForTamper = await receiveAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: happyAnswerDid, expectedIssuer: bWardenId.did });
  const tampered = { ...recvForTamper.answer!, provenance: 'inferred' as const, narrative: 'A rewrote this' };
  const verifyProof = aEmissary.keymaster.verifyProof.bind(aEmissary.keymaster) as (o: unknown) => Promise<boolean>;
  const tamperedVerifies = await verifyProof(tampered).catch(() => false);
  check('altering the provenance breaks B\'s signature (verifyProof rejects the tampered graph)', tamperedVerifies === false);

  // ── NO-RECOGNITION ──
  step('NO-RECOGNITION: A presents a cred not signed by a Sovereign B recognizes → REJECT at admission');
  const bogus = await issueRecognition({
    issuer: aWarden, // A's OWN Warden — not a Sovereign B recognizes
    issuerName: aWardenId.name,
    subject: aEmId.did,
    scope: { tier: 'trusted', confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 1 },
    registry: reg,
  });
  const rBogus = await meshB.handle(envelopeOf(validQuery, bogus));
  check('B REJECTS the unrecognized recognition', rBogus.status === 'rejected' && rBogus.check === 'recognition');
  if (rBogus.status === 'rejected') process.stdout.write(`      → ${rBogus.reason}\n`);

  // ── DEPTH-VIOLATION ──
  step('DEPTH-VIOLATION: query arrives claiming depth 2 → B\'s depth-1 partition policy REJECTS');
  const rDepth = await meshB.handle(envelopeOf({ ...validQuery, depth: 2 }));
  check('B REJECTS arrival depth 2', rDepth.status === 'rejected' && rDepth.check === 'depth');
  if (rDepth.status === 'rejected') process.stdout.write(`      → ${rDepth.reason}\n`);

  // ── BUDGET-EXCEEDED (A-side, attenuation scope) ──
  step('BUDGET-EXCEEDED: A\'s Emissary tries to exceed its delegated budget → blocked A-side (never reaches B)');
  const overScope = scopeQueryToDelegation({ ...validQuery, mode: 'reasoning' }, delegated, delegatedBudget);
  check('over-SCOPE (mode:reasoning not delegated) blocked by the attenuation chain', !overScope.ok);
  if (!overScope.ok) process.stdout.write(`      → ${overScope.reason}\n`);
  const overBudget = scopeQueryToDelegation({ ...validQuery, budget: { maxNodes: 100, rate: 2 } }, delegated, delegatedBudget);
  check('over-BUDGET (maxNodes 100 > delegated 10) blocked A-side', !overBudget.ok);
  if (!overBudget.ok) process.stdout.write(`      → ${overBudget.reason}\n`);

  // ── REVOKED-RECOGNITION (run last — publishes to the durable list) ──
  step('REVOKED-RECOGNITION: B\'s Sovereign publishes a revocation, A presents the cred → REJECT');
  await publishRevocation(bSov, bSovId.name, listDid, recognition.recognitionId, configB);
  const rRevoked = await meshB.handle(envelopeOf(validQuery));
  check('B REJECTS the revoked recognition', rRevoked.status === 'rejected' && rRevoked.check === 'revocation');
  if (rRevoked.status === 'rejected') process.stdout.write(`      → ${rRevoked.reason}\n`);

  process.stdout.write(
    failures === 0
      ? '\n✓ mesh v1: the fence-builder loop closes — trust-gated admission, budget attenuation, and a signed, pairwise-encrypted evidence graph\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-mesh: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
