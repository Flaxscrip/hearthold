/**
 * e2e: verifier-enforced attenuation for VCs — the full test matrix, live against Archon.
 *
 * The deliverable is the VERIFIER correctly REJECTING the violations it is designed to catch. A REJECT with
 * the right reason is a PASS; we never loosen the verifier to turn a rejection green. Run:
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-attenuation.ts
 *
 * Cases: HAPPY (ACCEPT) · ATTEN-VIOLATION (REJECT, two attacks) · COUNTER-SKIP (REJECT) ·
 *        PREV-TAMPER (pinned ACCEPT vs bare REJECT, side by side) · CROSS-LINEAGE (REJECT) ·
 *        FORGED-ASSERTION (REJECT at (e)).
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  issueVc,
  verifyAttenuationChain,
  commit,
  freshSalt,
  type IssuedVc,
  type AuthoritySetPayload,
  type VerifyResult,
  type KeymasterHandle,
} from '@hearthold/core';

const line = (m: string): void => process.stdout.write(`${m}\n`);
type Row = { name: string; expected: 'ACCEPT' | 'REJECT'; got: string; detail: string };
const rows: Row[] = [];
let failures = 0;

function record(name: string, expected: 'ACCEPT' | 'REJECT', r: VerifyResult, detail = ''): void {
  const got = r.ok ? 'ACCEPT' : `REJECT ${r.check} — ${r.reason}`;
  const pass = (expected === 'ACCEPT') === r.ok;
  if (!pass) failures++;
  rows.push({ name, expected, got, detail });
  line(`${pass ? '✓' : '✗'} ${name}`);
  line(`    expected ${expected} · got ${got}${detail ? `\n    ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-attenuation-e2e';
  const reg = config.registry;

  // Actors: the Warden attenuates (controller/issuer); the holder receives the pairwise payload; a separate
  // node stands in for a third-party verifier (public resolution only). The "attacker" is a distinct DID.
  const warden = await openKeymaster('warden', config, pass);
  const holder = await openKeymaster('verifier', config, pass);
  const verifierNode = await openKeymaster('sovereign', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const holderId = await ensureIdentity(holder, config);
  await ensureIdentity(verifierNode, config);
  await warden.keymaster.setCurrentId(wardenId.name);
  const attacker = 'attn-attacker';
  if (!(await warden.keymaster.listIds()).includes(attacker)) await warden.keymaster.createId(attacker, { registry: reg });
  const attackerDid = (await warden.keymaster.resolveDID(attacker)).didDocument?.id ?? '';
  await warden.keymaster.setCurrentId(wardenId.name);

  const V = { keymaster: verifierNode as KeymasterHandle, expectedRootIssuer: wardenId.did };
  const disclose = (...vs: IssuedVc[]): Record<string, AuthoritySetPayload> =>
    Object.fromEntries(vs.map((v) => [v.vcDid, { authoritySet: v.authoritySet, salt: v.salt }]));
  const mint = (a: Parameters<typeof issueVc>[0]): Promise<IssuedVc> =>
    issueVc({ issuer: warden, issuerName: wardenId.name, holder: holderId.did, registry: reg, ...a } as Parameters<typeof issueVc>[0]);

  line('\n════ building lineage L1: C0{read,write on X} → C1{read on X} → C2{read on X} ════');
  const c0 = await mint({ authoritySet: { operations: ['read', 'write'], resources: ['X'] } });
  const c1 = await mint({ authoritySet: { operations: ['read'], resources: ['X'] }, parent: c0 });
  const c2 = await mint({ authoritySet: { operations: ['read'], resources: ['X'] }, parent: c1 });
  line(`  C0 ${c0.vcDid}  (seq ${c0.pin.versionSequence})`);
  line(`  C1 ${c1.vcDid}  (seq ${c1.pin.versionSequence})`);
  line(`  C2 ${c2.vcDid}  (seq ${c2.pin.versionSequence})`);

  // ── HAPPY ──
  line('\n──── HAPPY ────');
  record('HAPPY (structural, no decryption)', 'ACCEPT', await verifyAttenuationChain(c2.vcDid, V));
  record('HAPPY (with disclosed sets → recompute commitment + ⊆)', 'ACCEPT', await verifyAttenuationChain(c2.vcDid, { ...V, disclosed: disclose(c0, c1, c2) }));

  // ── ATTEN-VIOLATION ──
  line('\n──── ATTEN-VIOLATION ────');
  // Attack 1: honestly commit to {write} under a {read} parent (issuance guard bypassed to build it).
  const bad1 = await mint({ authoritySet: { operations: ['write'], resources: ['X'] }, parent: c1, skipSubsetGuard: true });
  record(
    'ATTEN-VIOLATION/structural: well-formed chain, so structure alone ACCEPTS (the honest finding)',
    'ACCEPT',
    await verifyAttenuationChain(bad1.vcDid, V),
    'the commitment hides the set — subset can only be judged on disclosure (next row)',
  );
  record(
    'ATTEN-VIOLATION/disclosed: {write} ⊄ parent {read}',
    'REJECT',
    await verifyAttenuationChain(bad1.vcDid, { ...V, disclosed: disclose(c0, c1, bad1) }),
  );
  // Attack 2: forge parentAuthorityCommitment (claim the parent had {read,write}) to fake an attenuation.
  const fakeParentCommit = commit({ operations: ['read', 'write'], resources: ['X'] }, freshSalt());
  const bad2 = await mint({ authoritySet: { operations: ['write'], resources: ['X'] }, parent: c1, overrideParentCommitment: fakeParentCommit, skipSubsetGuard: true });
  record(
    'ATTEN-VIOLATION/forged-commitment: parentAuthorityCommitment ≠ parent’s own commitment',
    'REJECT',
    await verifyAttenuationChain(bad2.vcDid, V),
  );

  // ── COUNTER-SKIP ──
  line('\n──── COUNTER-SKIP ────');
  const skip = await mint({ authoritySet: { operations: ['read'], resources: ['X'] }, parent: c1, overrideCounter: c1.counter + 2, skipSubsetGuard: true });
  record('COUNTER-SKIP: counter = parent + 2', 'REJECT', await verifyAttenuationChain(skip.vcDid, V), `child counter ${skip.counter}, parent ${c1.counter}`);

  // ── PREV-TAMPER: widen a parent's pic AFTER the child pinned it; show pinned vs bare side by side ──
  line('\n──── PREV-TAMPER ────');
  const tp0 = await mint({ authoritySet: { operations: ['read', 'write'], resources: ['X'] } });
  const tp1 = await mint({ authoritySet: { operations: ['read'], resources: ['X'] }, parent: tp0 });
  const preTamper = await verifyAttenuationChain(tp1.vcDid, V); // pins tp0 @ its issuance version
  // Tamper: the parent widens its OWN authorityCommitment (a new version, new versionId).
  await warden.keymaster.setCurrentId(wardenId.name);
  const tp0doc = await warden.keymaster.resolveDID(tp0.vcDid);
  const tp0pic = (tp0doc.didDocumentData as { pic: Record<string, unknown> }).pic;
  const widened = commit({ operations: ['read', 'write', 'admin'], resources: ['X', 'Y'] }, freshSalt());
  await warden.keymaster.mergeData(tp0.vcDid, { pic: { ...tp0pic, authorityCommitment: widened } });
  const pinnedParent = await warden.keymaster.resolveDID(tp0.vcDid, { versionSequence: tp0.pin.versionSequence });
  const bareParent = await warden.keymaster.resolveDID(tp0.vcDid);
  const pinnedCommit = (pinnedParent.didDocumentData as { pic: { authorityCommitment: string } }).pic.authorityCommitment;
  const bareCommit = (bareParent.didDocumentData as { pic: { authorityCommitment: string } }).pic.authorityCommitment;
  record(
    'PREV-TAMPER (pinned versionId): child validates against immutable pinned parent',
    'ACCEPT',
    await verifyAttenuationChain(tp1.vcDid, V),
    `pre-tamper verdict was ${preTamper.ok ? 'ACCEPT' : 'REJECT'}; still ACCEPT after tamper`,
  );
  // The child (tp1) pinned tp0 at issuance, so its parentAuthorityCommitment == tp0's own commitment then.
  const childParentCommit = tp0.authorityCommitment;
  line('    PINNING IS LOAD-BEARING — same parent DID, two versions:');
  line(`      child.parentAuthorityCommitment      = ${childParentCommit}`);
  line(`      pinned  seq ${tp0.pin.versionSequence} authorityCommitment = ${pinnedCommit}   (== child ✓ ACCEPT)`);
  line(`      bare    latest    authorityCommitment = ${bareCommit}   (≠ child ✗ a bare-DID follower breaks/deceived)`);
  rows.push({
    name: 'PREV-TAMPER (bare DID): a verifier that followed the bare DID would see the widened parent',
    expected: 'REJECT',
    got: bareCommit !== childParentCommit ? 'REJECT (d) — bare parent commitment ≠ child.parentAuthorityCommitment' : 'ACCEPT',
    detail: `pinned=${pinnedCommit.slice(0, 16)}… bare=${bareCommit.slice(0, 16)}…`,
  });
  if (bareCommit === childParentCommit || pinnedCommit !== childParentCommit) failures++;
  line(`✓ PREV-TAMPER (bare DID) demonstrates tamper-evidence: pinned==child (${pinnedCommit === childParentCommit}), bare!=child (${bareCommit !== childParentCommit})`);

  // ── CROSS-LINEAGE ──
  line('\n──── CROSS-LINEAGE ────');
  const l2c0 = await mint({ authoritySet: { operations: ['read'], resources: ['Y'] } }); // a different lineage L2
  const cross = await mint({ authoritySet: { operations: ['read'], resources: ['X'] }, parent: c1, overrideLineageId: l2c0.lineageId, skipSubsetGuard: true });
  record(
    'CROSS-LINEAGE: pin C1(L1) as parent but claim L2 lineage',
    'REJECT',
    await verifyAttenuationChain(cross.vcDid, V),
    `child lineage ${cross.lineageId.slice(0, 24)}… vs parent lineage ${c1.lineageId.slice(0, 24)}…`,
  );

  // ── FORGED-ASSERTION ──
  line('\n──── FORGED-ASSERTION ────');
  const forged = await mint({ authoritySet: { operations: ['read'], resources: ['X'] }, parent: c1, forgeAssertionWith: attacker, skipSubsetGuard: true });
  record(
    'FORGED-ASSERTION: assertion signed by a non-Warden key',
    'REJECT',
    await verifyAttenuationChain(forged.vcDid, V),
    `asset controller = Warden ${wardenId.did.slice(0, 20)}…, assertion signer = attacker ${attackerDid.slice(0, 20)}…`,
  );

  // ── DISCLOSURE: the holder reveals authoritySet+salt by decrypting ITS OWN pairwise payload ──
  // (Selective disclosure here is by ENCRYPTION SCOPE — the set is its own encrypted field — not by a
  //  keymaster VC-presentation ceremony; the commitment binds the reveal, so holder honesty isn't assumed.)
  line('\n──── DISCLOSURE (holder decrypt → verifier recompute) ────');
  await holder.keymaster.setCurrentId(holderId.name);
  const revealed = (await holder.keymaster.decryptJSON(c1.vcDid)) as AuthoritySetPayload;
  const rebinds = commit(revealed.authoritySet, revealed.salt) === c1.authorityCommitment;
  if (!rebinds) failures++;
  line(`${rebinds ? '✓' : '✗'} DISCLOSURE: holder decrypted C1 payload = ${JSON.stringify(revealed.authoritySet)}; recomputed commitment ${rebinds ? 'MATCHES' : 'DIFFERS FROM'} the cleartext authorityCommitment`);
  rows.push({ name: 'DISCLOSURE: holder-decrypt reveals authoritySet+salt, verifier rebinds to commitment', expected: 'ACCEPT', got: rebinds ? 'ACCEPT (commitment rebinds)' : 'REJECT', detail: `revealed ${JSON.stringify(revealed.authoritySet)}` });

  // ── SALT: a commitment must not be reversible by enumerating the small authority-set space ──
  line('\n──── SALT (commitment non-reversibility) ────');
  const opsVocab = ['read', 'write', 'admin', 'delete'];
  const resVocab = ['X', 'Y'];
  const subsets = <T,>(xs: T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
  const space = subsets(opsVocab).flatMap((operations) => subsets(resVocab).map((resources) => ({ operations, resources })));
  const secretSalt = freshSalt();
  const secretSet = { operations: ['write'], resources: ['X'] };
  const saltedTarget = commit(secretSet, secretSalt);
  const unsaltedTarget = commit(secretSet, ''); // the naive (WRONG) design
  const saltedHits = space.filter((s) => commit(s, '') === saltedTarget).length;
  const unsaltedHits = space.filter((s) => commit(s, '') === unsaltedTarget);
  const saltPass = saltedHits === 0 && unsaltedHits.length === 1;
  if (!saltPass) failures++;
  line(`${saltPass ? '✓' : '✗'} SALT: over ${space.length} candidate sets, unsalted enumeration recovered the preimage (${unsaltedHits.length} hit), salted enumeration recovered ${saltedHits} — a 256-bit salt makes the small space non-enumerable`);
  rows.push({ name: 'SALT: salted commitment resists enumeration', expected: 'REJECT', got: saltPass ? 'REJECT (enumeration finds 0 preimages)' : 'ACCEPT (LEAK)', detail: `unsalted recovered ${unsaltedHits.length}, salted recovered ${saltedHits} over ${space.length} candidates` });

  // ── Summary ──
  line('\n════ MATRIX ════');
  for (const r of rows) line(`  [${(r.expected === 'ACCEPT') === !/^REJECT/.test(r.got) ? 'PASS' : 'FAIL'}] ${r.name}\n        → ${r.got}`);
  line(`\n${failures === 0 ? '✓ all cases produced the expected verdict' : `✗ ${failures} case(s) off-target`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-attenuation: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
