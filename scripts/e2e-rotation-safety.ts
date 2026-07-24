/**
 * e2e: ROTATION-SAFETY — a signed mesh answer survives the signer's key rotation, and a retired key
 * cannot mint a NEW valid signature.
 *
 * Why this matters: nothing else signs and verifies ACROSS a rotation, and transport adds a second party
 * (a relay/answerer) whose key rotations we cannot coordinate. The guarantee we depend on: Archon resolves
 * the verification key that MATCHES the credential (its key epoch), so an answer signed before a rotation
 * still verifies after it — while a signature made with the retired key, repurposed for new content, is
 * rejected. Both are exercised through the real mesh verify path (`receiveAnswer` → `verifyProof` + signer
 * check, mesh.ts:549-553), the same `addProof`/`encryptJSON` the Warden uses to sign an answer (mesh.ts:450).
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-rotation-safety.ts
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  receiveAnswer,
  IDENTITY_NAME,
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-rotation-e2e';
  const cfgB = { ...base, dataRoot: join(base.dataRoot, 'B') };
  const cfgA = { ...base, dataRoot: join(base.dataRoot, 'A') };

  step('Provision B (Warden, the signer) and A (Emissary, the recipient)');
  const bWarden = await openKeymaster('warden', cfgB, pass);
  const aEmissary = await openKeymaster('emissary', cfgA, pass);
  const bWardenId = await ensureIdentity(bWarden, cfgB);
  const aEmId = await ensureIdentity(aEmissary, cfgA);
  const km = bWarden.keymaster;
  await km.setCurrentId(IDENTITY_NAME.warden);
  check('identities ready', bWardenId.did.startsWith('did:') && aEmId.did.startsWith('did:'));

  // Sign a mesh answer exactly as MeshWarden.handle does (addProof), then seal it pairwise to A (encryptJSON).
  const signAnswerToA = async (body: Record<string, unknown>): Promise<{ answerDid: string; vm: string }> => {
    await km.setCurrentId(IDENTITY_NAME.warden);
    const signed = (await km.addProof(body, IDENTITY_NAME.warden)) as Record<string, unknown> & {
      proof?: { verificationMethod?: string };
    };
    const answerDid = await km.encryptJSON(signed, aEmId.did, { registry: base.registry });
    return { answerDid, vm: signed.proof?.verificationMethod ?? '' };
  };
  const recv = (answerDid: string) =>
    receiveAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid, expectedIssuer: bWardenId.did });

  step('B signs answer A (key epoch 1) and seals it to A; A verifies it');
  const answerA = await signAnswerToA({ reference: 'gate-code', narrative: 'the side gate code is 4-8-1-5', n: 1 });
  const rA1 = await recv(answerA.answerDid);
  check('answer A verifies before rotation', rA1.ok === true);
  check("A's proof is under key-1", /#key-1$/.test(answerA.vm));

  step("B rotates its Warden key (epoch 1 → 2) — a rotation A never coordinated");
  const rotated = await km.rotateKeys();
  check('rotateKeys succeeded', rotated === true);

  step('CORE PROPERTY: the pre-rotation answer STILL verifies (Archon resolves the credential-matching key)');
  const rA2 = await recv(answerA.answerDid);
  check('answer A STILL verifies after rotation', rA2.ok === true);

  step('Rotation is real: a NEW answer is signed under the new key epoch and verifies');
  const answerB = await signAnswerToA({ reference: 'gate-code', narrative: 'the side gate code is 4-8-1-5', n: 2 });
  const rB = await recv(answerB.answerDid);
  check("B's proof is under key-2 (the signing key actually changed)", /#key-2$/.test(answerB.vm) && answerB.vm !== answerA.vm);
  check('answer B verifies under the rotated key', rB.ok === true);

  step('SAFETY: a retired-key signature repurposed for NEW content is REJECTED');
  // Graft answer A's retired-key proof onto altered content and seal it to A. verifyProof must reject it:
  // the key-1 signature does not cover the new body, so a captured retired-key signature cannot be reused.
  await aEmissary.keymaster.setCurrentId(aEmId.name);
  const aFull = (await aEmissary.keymaster.decryptJSON(answerA.answerDid)) as { proof?: unknown };
  const forged = { reference: 'gate-code', narrative: 'FORGED: the gate code is 0-0-0-0', n: 999, proof: aFull.proof };
  await km.setCurrentId(IDENTITY_NAME.warden);
  const forgedDid = await km.encryptJSON(forged, aEmId.did, { registry: base.registry });
  const rForged = await recv(forgedDid);
  check('a new claim carrying the retired key’s signature is REJECTED (signature does not verify)', rForged.ok === false);

  process.stdout.write(
    failures === 0
      ? '\n✓ rotation-safety: pre-rotation signatures verify across a rotation; a retired key mints no new valid signature\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-rotation-safety: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
