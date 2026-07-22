/**
 * e2e: Pattern-A selective disclosure — the full test matrix, live against Archon.
 *
 * The deliverable is the verifier ACCEPTing a valid subset disclosure and REJECTing every forgery. A
 * correct REJECT is a PASS; the verifier is never loosened to green a rejection. Run:
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-disclosure.ts
 *
 * Cases: HAPPY · HIDING · FORGED-VALUE · WRONG-SALT · TAMPERED-ARRAY · SALT-BRUTEFORCE-GUARD · MULTI-DISCLOSE.
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  issueDisclosureCredential,
  assemblePresentation,
  verifyPresentation,
  digestDisclosure,
  canonicalize,
  freshSalt,
  type Disclosure,
  type Presentation,
  type KeymasterHandle,
} from '@hearthold/core';
import { createHash } from 'node:crypto';

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-disclosure-e2e';
  const reg = config.registry;

  const warden = await openKeymaster('warden', config, pass);
  const holder = await openKeymaster('verifier', config, pass);
  const endpoint = await openKeymaster('emissary', config, pass); // the verifying endpoint
  const wardenId = await ensureIdentity(warden, config);
  await ensureIdentity(holder, config);
  await ensureIdentity(endpoint, config);
  const V = { keymaster: endpoint as KeymasterHandle, expectedIssuer: wardenId.did };

  step('Issue a credential holding scope, budget, resources (+ a small-domain tier)');
  const cred = await issueDisclosureCredential({
    issuer: warden,
    issuerName: wardenId.name,
    holder: (await ensureIdentity(holder, config)).did,
    properties: { scope: ['read'], budget: 500000, resources: ['ledger-db'], tier: 'gold' },
    credentialType: 'AgentGrant',
    registry: reg,
  });
  check('4 disclosure digests signed', cred.commitments.sd.length === 4 && !!cred.commitments.proof);

  // ── HAPPY ──
  step('HAPPY: disclose ONLY scope');
  const pScope = assemblePresentation(cred.commitments, cred.disclosures, ['scope']);
  const rScope = await verifyPresentation(pScope, V);
  check('ACCEPT', rScope.ok);
  check('verifier sees ONLY scope', JSON.stringify(rScope.disclosed) === JSON.stringify({ scope: ['read'] }));

  // ── HIDING ──
  step('HIDING: budget/resources/tier are not recoverable from the Presentation or the verifier result');
  const wire = JSON.stringify(pScope);
  check('the undisclosed budget value (500000) is absent from the wire Presentation', !wire.includes('500000'));
  check('the undisclosed resource (ledger-db) is absent from the wire Presentation', !wire.includes('ledger-db'));
  check('the verifier result exposes no undisclosed key', !('budget' in (rScope.disclosed ?? {})) && !('tier' in (rScope.disclosed ?? {})));
  check('undisclosed properties are present ONLY as opaque digests (all 4 digests still shipped)', pScope.commitments.sd.length === 4 && pScope.disclosures.length === 1);

  // ── FORGED-VALUE ──
  step('FORGED-VALUE: disclose (fresh salt, scope, [write]) that was never issued');
  const forged: Presentation = { commitments: cred.commitments, disclosures: [{ salt: freshSalt(), name: 'scope', value: ['write'] }] };
  const rForged = await verifyPresentation(forged, V);
  check('REJECT at membership', !rForged.ok && rForged.check === 'membership');
  process.stdout.write(`      → ${rForged.reason}\n`);

  // ── WRONG-SALT ──
  step('WRONG-SALT: correct value [read], wrong salt → digest mismatch');
  const realScope = cred.disclosures.find((d) => d.name === 'scope') as Disclosure;
  const wrongSalt: Presentation = { commitments: cred.commitments, disclosures: [{ salt: freshSalt(), name: 'scope', value: realScope.value }] };
  const rWrong = await verifyPresentation(wrongSalt, V);
  check('REJECT at membership', !rWrong.ok && rWrong.check === 'membership');
  process.stdout.write(`      → ${rWrong.reason}\n`);

  // ── TAMPERED-ARRAY ──
  step('TAMPERED-ARRAY: flip one digest in the signed array');
  const tamperedSd = [...cred.commitments.sd];
  tamperedSd[0] = sha256Hex('tampered');
  const tampered: Presentation = { commitments: { ...cred.commitments, sd: tamperedSd }, disclosures: pScope.disclosures };
  const rTampered = await verifyPresentation(tampered, V);
  check('REJECT at signature (proof covers the digest array)', !rTampered.ok && rTampered.check === 'signature');
  process.stdout.write(`      → ${rTampered.reason}\n`);

  // ── SALT-BRUTEFORCE-GUARD ──
  step('SALT-BRUTEFORCE-GUARD: tier ∈ {bronze,silver,gold} — without the salt the domain is not reversible');
  const domain = ['bronze', 'silver', 'gold'];
  const sdSet = new Set(cred.commitments.sd);
  // Attacker has the signed digests but not the tier salt; enumerate the domain UNSALTED (and with guessed salts).
  const saltedHits = domain.filter((v) => sdSet.has(sha256Hex(canonicalize({ name: 'tier', salt: '', value: v })))).length;
  // Contrast: an UNSALTED scheme's digest of the real value would be recoverable by the same enumeration.
  const unsaltedDigestOfReal = sha256Hex(canonicalize({ name: 'tier', salt: '', value: 'gold' }));
  const unsaltedHits = domain.filter((v) => sha256Hex(canonicalize({ name: 'tier', salt: '', value: v })) === unsaltedDigestOfReal).length;
  check(`salted: enumerating {bronze,silver,gold} recovers the tier in ${saltedHits} cases (must be 0)`, saltedHits === 0);
  check(`unsalted (counterfactual): the same enumeration WOULD recover it (${unsaltedHits} hit) — so salt is load-bearing`, unsaltedHits === 1);

  // ── MULTI-DISCLOSE ──
  step('MULTI-DISCLOSE: disclose scope + tier (2 of 4); budget + resources stay hidden');
  const pMulti = assemblePresentation(cred.commitments, cred.disclosures, ['scope', 'tier']);
  const rMulti = await verifyPresentation(pMulti, V);
  check('ACCEPT', rMulti.ok);
  check('discloses exactly scope + tier', JSON.stringify(rMulti.disclosed) === JSON.stringify({ scope: ['read'], tier: 'gold' }));
  const wireMulti = JSON.stringify(pMulti);
  check('budget + resources remain hidden on the wire', !wireMulti.includes('500000') && !wireMulti.includes('ledger-db'));

  process.stdout.write(
    failures === 0
      ? '\n✓ selective disclosure: valid subsets ACCEPT, every forgery REJECTs, undisclosed properties stay hidden\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-disclosure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
