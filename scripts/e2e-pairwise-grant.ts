/**
 * e2e: H1 — pairwise DIDs, one engine two masters (CGPR grants + DTG R-DIDs).
 *
 * Proves the A2A-brief §3 requirements:
 *   CGPR — a grant to C₁ and a grant to C₂ from the SAME vault get DIFFERENT pairwise subject DIDs;
 *          C₁'s verifier learns nothing linking to C₂ or to the Sovereign; the linkage never leaves
 *          the Warden; single-use burns; revocation kills a grant.
 *   DTG  — two VRCs to two counterparties are issued from DISTINCT per-relationship R-DIDs; both
 *          verify and present through challenge/response.
 *   MUST — a non-pairwise (stable) subject is refused by default, permitted only under a signed
 *          Ruleset exception, and refused again once that exception is removed.
 *
 * Isolated under a throwaway data root; run:  npm run e2e:pairwise-grant
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureSchema,
  openSchema,
  acceptCredential,
  revokeCredential,
  requestProof,
  presentProof,
  verifyProof,
  mintPairwiseGrant,
  issueVrcToCounterparty,
  pairwiseName,
  signRuleset,
  activeRuleset,
  rulesetId,
  MemorySpentTxnStore,
  MemoryPairwiseStore,
  Sensitivity,
  type EvidenceGroup,
  type Ruleset,
} from '@hearthold/core';
import { FilePairwiseStore } from '@hearthold/warden/pairwise-store';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const now = (): string => new Date().toISOString();
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
};

/** A minimal witnessed evidence group — the pairwise engine is orthogonal to provenance shape. */
function group(tag: string): EvidenceGroup {
  return {
    id: hex(`grp-${tag}`),
    type: ['HearthholdEvidenceGroup'],
    kind: 'document',
    observedFrom: '2026-06-01',
    observedTo: '2026-06-30',
    count: 1,
    witnessedBy: ['self'],
    commitment: { alg: 'sha256', merkleRoot: hex(`root-${tag}`), artefactIds: hex(`ids-${tag}`) },
    disclosure: 'summary',
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-pairwise';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const c1 = await openKeymaster('verifier', config, pass); // counterparty / verifier C₁
  const c2 = await openKeymaster('registry', config, pass); // counterparty / verifier C₂
  const relier = await openKeymaster('emissary', config, pass); // relying verifier for the DTG leg

  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const c1Id = await ensureIdentity(c1, config);
  const c2Id = await ensureIdentity(c2, config);
  await ensureIdentity(relier, config);

  const store = new FilePairwiseStore(warden);
  const spent = new MemorySpentTxnStore();
  const AUD1 = 'https://c1.example/agent-card';
  const AUD2 = 'https://c2.example/agent-card';

  // ── CGPR leg ────────────────────────────────────────────────────────────────
  const grant1 = await mintPairwiseGrant(warden, store, {
    audience: AUD1,
    sovereignDid: sovId.did,
    activeRuleset: null,
    createdAt: now(),
    registry: config.registry,
    claim: 'Holds a dietary-restriction preference',
    structured: { 'foodAndBeverage.dietaryRestrictions': 'vegetarian' },
    evidence: [group('c1')],
    txn: randomBytes(12).toString('hex'),
  });
  const grant2 = await mintPairwiseGrant(warden, store, {
    audience: AUD2,
    sovereignDid: sovId.did,
    activeRuleset: null,
    createdAt: now(),
    registry: config.registry,
    claim: 'Holds a dietary-restriction preference',
    structured: { 'foodAndBeverage.dietaryRestrictions': 'vegetarian' },
    evidence: [group('c2')],
    txn: randomBytes(12).toString('hex'),
  });

  assert(grant1.pairwise && grant2.pairwise, 'both grants must be pairwise');
  assert(grant1.subjectDid !== grant2.subjectDid, 'C₁ and C₂ must get DIFFERENT pairwise subject DIDs');
  assert(grant1.subjectDid !== sovId.did && grant2.subjectDid !== sovId.did, 'subject must never be the Sovereign DID');
  process.stdout.write(
    `CGPR grants minted:\n  C₁ subject ${grant1.subjectDid.slice(0, 28)}…\n  C₂ subject ${grant2.subjectDid.slice(0, 28)}…\n`,
  );

  // C₁ verifies grant1 (Warden presents AS the pairwise-1 id, which holds the grant).
  await warden.keymaster.setCurrentId(pairwiseName(AUD1));
  assert(await acceptCredential(warden, grant1.credentialDid), 'pairwise-1 accepts its grant');
  const ch1 = await requestProof(c1, { schema: grant1.schemaDid, trustedIssuers: [wardenId.did] });
  await warden.keymaster.setCurrentId(pairwiseName(AUD1));
  const pres1 = await presentProof(warden, ch1);
  const res1 = await verifyProof(c1, pres1, { trustedIssuers: [wardenId.did], schema: grant1.schemaDid, spentTxns: spent });
  assert(res1.ok, `C₁ verification failed: ${JSON.stringify(res1)}`);
  assert(res1.responder === grant1.subjectDid, 'responder must be the pairwise-1 DID');

  // Unlinkability: nothing C₁ sees links to C₂ or the Sovereign.
  const wire1 = JSON.stringify(res1);
  assert(!wire1.includes(sovId.did), 'C₁ must not see the Sovereign DID');
  assert(!wire1.includes(grant2.subjectDid), 'C₁ must not see C₂’s pairwise DID');
  assert(!wire1.includes(AUD2), 'C₁ must not see C₂’s audience');
  process.stdout.write('✓ C₁ verified; no linkage to C₂ or the Sovereign in what it saw\n');

  // Burn: a second presentation of the same single-use txn is refused.
  const ch1b = await requestProof(c1, { schema: grant1.schemaDid, trustedIssuers: [wardenId.did] });
  await warden.keymaster.setCurrentId(pairwiseName(AUD1));
  const pres1b = await presentProof(warden, ch1b);
  const res1b = await verifyProof(c1, pres1b, { trustedIssuers: [wardenId.did], schema: grant1.schemaDid, spentTxns: spent });
  assert(!res1b.ok, 'second presentation must be refused (burned)');
  process.stdout.write(`✓ single-use burn: replay refused (${res1b.reason})\n`);

  // Linkage stays Warden-side: the store maps each pairwise DID back to the Sovereign (positive), but
  // that mapping never crossed to C₁ (asserted above on what C₁ saw).
  const link1 = await store.get(grant1.subjectDid);
  const link2 = await store.get(grant2.subjectDid);
  assert(link1?.subjectDid === sovId.did && link2?.subjectDid === sovId.did, 'Warden store links both pairwise DIDs → Sovereign');
  assert(link1?.audience === AUD1 && link2?.audience === AUD2, 'store keys each pairwise DID by its audience');
  process.stdout.write('✓ linkage held Warden-side only (pairwise→Sovereign in the store, never on the wire)\n');

  // Revoke: revoking grant2 makes C₂ unable to verify it.
  await revokeCredential(warden, grant2.credentialDid);
  const ch2 = await requestProof(c2, { schema: grant2.schemaDid, trustedIssuers: [wardenId.did] });
  await warden.keymaster.setCurrentId(pairwiseName(AUD2));
  const pres2 = await presentProof(warden, ch2);
  const res2 = await verifyProof(c2, pres2, { trustedIssuers: [wardenId.did], schema: grant2.schemaDid });
  assert(!res2.ok, 'revoked grant must not verify');
  process.stdout.write(`✓ revocation: C₂’s grant no longer verifies (${res2.reason})\n`);
  await warden.keymaster.setCurrentId('hearthold-warden');

  // ── DTG leg: distinct R-DIDs per counterparty ─────────────────────────────────
  const issuerStore = new MemoryPairwiseStore(); // the issuer's own per-counterparty R-DIDs
  const vrcSchema = await ensureSchema(sovereign, 'DtgRelationship', openSchema('DtgRelationship'));
  const edgeA = await issueVrcToCounterparty(sovereign, issuerStore, {
    counterparty: c1Id.did,
    schemaDid: vrcSchema,
    issuerDid: sovId.did,
    activeRuleset: null,
    createdAt: now(),
    registry: config.registry,
  });
  const edgeB = await issueVrcToCounterparty(sovereign, issuerStore, {
    counterparty: c2Id.did,
    schemaDid: vrcSchema,
    issuerDid: sovId.did,
    activeRuleset: null,
    createdAt: now(),
    registry: config.registry,
  });
  assert(edgeA.issuerDid !== edgeB.issuerDid, 'each counterparty must get a DISTINCT issuer R-DID');
  assert(edgeA.issuerDid !== sovId.did && edgeB.issuerDid !== sovId.did, 'issuer R-DID must never be the stable Sovereign DID');
  process.stdout.write(
    `DTG VRCs issued from distinct R-DIDs:\n  →A R-DID ${edgeA.issuerDid.slice(0, 28)}…\n  →B R-DID ${edgeB.issuerDid.slice(0, 28)}…\n`,
  );

  // Both present through challenge/response (each counterparty holds + presents its VRC).
  assert(await acceptCredential(c1, edgeA.credentialDid), 'C₁ accepts VRC A');
  const chA = await requestProof(relier, { schema: vrcSchema, trustedIssuers: [edgeA.issuerDid] });
  const presA = await presentProof(c1, chA);
  const resA = await verifyProof(relier, presA, { trustedIssuers: [edgeA.issuerDid], schema: vrcSchema });
  assert(resA.ok && resA.disclosed[0]?.issuer === edgeA.issuerDid, `VRC A must verify from R-DID A: ${JSON.stringify(resA)}`);

  assert(await acceptCredential(c2, edgeB.credentialDid), 'C₂ accepts VRC B');
  const chB = await requestProof(relier, { schema: vrcSchema, trustedIssuers: [edgeB.issuerDid] });
  const presB = await presentProof(c2, chB);
  const resB = await verifyProof(relier, presB, { trustedIssuers: [edgeB.issuerDid], schema: vrcSchema });
  assert(resB.ok && resB.disclosed[0]?.issuer === edgeB.issuerDid, `VRC B must verify from R-DID B: ${JSON.stringify(resB)}`);
  process.stdout.write('✓ both VRCs present + verify through challenge/response, unlinkable issuers\n');

  // ── Enforcement leg: the MUST (stable subject needs a signed Ruleset exception) ──
  const EXC_AUD = 'https://autoura.example/broker'; // the audience the Sovereign deliberately allows stable
  const base = (over: Partial<Ruleset>): Ruleset => ({
    actor: 'a2a-gateway',
    actorKind: 'gateway',
    version: 1,
    previous: null,
    capabilities: {},
    ceiling: Sensitivity.HIGH,
    status: 'active',
    ...over,
  });

  // (1) refused by default — no Ruleset, stable subject.
  let refusedByDefault = false;
  try {
    await mintPairwiseGrant(warden, store, {
      audience: EXC_AUD,
      sovereignDid: sovId.did,
      activeRuleset: null,
      createdAt: now(),
      stableSubject: sovId.did,
      claim: 'x',
      evidence: [group('exc')],
      txn: randomBytes(12).toString('hex'),
    });
  } catch (e) {
    refusedByDefault = /refused/.test(String(e));
  }
  assert(refusedByDefault, 'a stable subject must be refused by default');

  // (2) permitted under a signed exception for that audience.
  const v1 = await signRuleset(sovereign, base({ capabilities: { stableDidAudiences: [EXC_AUD] } }));
  const activeV1 = await activeRuleset(warden, [v1], { expectedSigner: sovId.did });
  assert(activeV1 !== null, 'v1 Ruleset must be active');
  const permitted = await mintPairwiseGrant(warden, store, {
    audience: EXC_AUD,
    sovereignDid: sovId.did,
    activeRuleset: activeV1,
    createdAt: now(),
    stableSubject: sovId.did,
    claim: 'deliberate-stable',
    evidence: [group('exc2')],
    txn: randomBytes(12).toString('hex'),
  });
  assert(!permitted.pairwise && permitted.subjectDid === sovId.did, 'exception must permit a stable subject');

  // (3) removing the exception (a signed v2) restores refusal.
  const v2 = await signRuleset(
    sovereign,
    base({ version: 2, previous: rulesetId(v1), capabilities: { stableDidAudiences: [] } }),
  );
  const activeV2 = await activeRuleset(warden, [v1, v2], { expectedSigner: sovId.did });
  assert(activeV2 !== null, 'v2 head must be active');
  let refusedAgain = false;
  try {
    await mintPairwiseGrant(warden, store, {
      audience: EXC_AUD,
      sovereignDid: sovId.did,
      activeRuleset: activeV2,
      createdAt: now(),
      stableSubject: sovId.did,
      claim: 'x',
      evidence: [group('exc3')],
      txn: randomBytes(12).toString('hex'),
    });
  } catch (e) {
    refusedAgain = /refused/.test(String(e));
  }
  assert(refusedAgain, 'removing the exception must restore refusal');
  process.stdout.write('✓ MUST enforced: refused by default → permitted under signed exception → refused once removed\n');

  process.stdout.write('\n✓ H1 pairwise-DID engine: CGPR grants + DTG R-DIDs + Warden-law enforcement\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-pairwise-grant: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
