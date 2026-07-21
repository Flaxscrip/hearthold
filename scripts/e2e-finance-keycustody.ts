/**
 * e2e: key-custody policy — the SOVEREIGN decides which R-DIDs it keys itself (financial theme).
 *
 * Which relationships does the Sovereign key in its own Signet (subject-keyed, proves control directly —
 * an identity anchor a counterparty KYCs) vs. let the Warden hold (Warden-keyed, presents on the
 * Sovereign's behalf — plain disclosure)? It is the SOVEREIGN's own choice, named per audience and SIGNED
 * into a Ruleset — never a built-in category. The Warden ENFORCES it: it may not key a relationship the
 * Sovereign chose to control, and the Sovereign can change its mind by signing a new version.
 *
 * Isolated data root; run:  npm run e2e:finance-keycustody
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signRuleset,
  rulesetId,
  resolveKeyHolder,
  enforceKeyCustody,
  resolvePairwiseDid,
  proveControl,
  mintPairwiseGrant,
  MemoryPairwiseStore,
  Sensitivity,
} from '@hearthold/core';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-finance-keycustody';
  const reg = config.registry;

  const sovereign = await openKeymaster('sovereign', config, pass);
  const warden = await openKeymaster('warden', config, pass);
  const bank = await openKeymaster('verifier', config, pass); // "Meridian Capital" — an identity anchor
  const analytics = await openKeymaster('emissary', config, pass); // an analytics verifier — plain disclosure
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(warden, config);
  const bankId = await ensureIdentity(bank, config);
  const analyticsId = await ensureIdentity(analytics, config);
  const now = new Date().toISOString();

  process.stdout.write('\n▸ The Sovereign SIGNS a key-custody policy (default: Warden; keys the bank ITSELF)\n');
  const policy = await signRuleset(sovereign, {
    actor: sovId.did,
    actorKind: 'sovereign',
    resource: 'key-custody',
    version: 1,
    previous: null,
    capabilities: { keyCustody: { default: 'warden', subject: [bankId.did] } },
    ceiling: Sensitivity.SEALED,
    status: 'active',
  });
  assert(resolveKeyHolder(policy, bankId.did) === 'subject', 'the Sovereign chose to key the bank relationship itself');
  assert(resolveKeyHolder(policy, analyticsId.did) === 'warden', 'a relationship not named defaults to Warden-keyed');

  process.stdout.write('\n▸ The Warden may NOT key the bank relationship (fail closed)\n');
  const wGate = enforceKeyCustody({ ruleset: policy, audience: bankId.did, mintedBy: 'warden' });
  assert(!wGate.ok, 'the Warden is refused from keying the bank — the Sovereign controls it');
  assert(enforceKeyCustody({ ruleset: policy, audience: bankId.did, mintedBy: 'subject' }).ok, 'a subject-keyed mint for the bank satisfies the policy');

  process.stdout.write('\n▸ The Sovereign keys the bank relationship (Signet) + proves control directly\n');
  const sovStore = new MemoryPairwiseStore();
  const rec = await resolvePairwiseDid(sovereign, sovStore, {
    audience: bankId.did,
    subjectDid: sovId.did,
    createdAt: now,
    keyHolder: 'subject',
    registry: reg,
  });
  assert(rec.keyHolder === 'subject', 'the bank R-DID is subject-keyed, matching the Sovereign policy');
  const challenge = await bank.keymaster.createChallenge({}, { registry: reg });
  const response = await proveControl(sovereign, rec.name, challenge, { registry: reg });
  const v = (await bank.keymaster.verifyResponse(response)) as { match?: boolean; responder?: string };
  assert(v.match === true && v.responder === rec.pairwiseDid, 'the Sovereign proves control of the bank R-DID with its own key');

  process.stdout.write('\n▸ The Warden keys a plain-disclosure relationship (policy default: Warden)\n');
  const wardenStore = new MemoryPairwiseStore();
  const disc = await resolvePairwiseDid(warden, wardenStore, {
    audience: analyticsId.did,
    subjectDid: sovId.did,
    createdAt: now,
    keyHolder: 'warden',
    registry: reg,
  });
  assert(disc.keyHolder === 'warden', 'the Warden keys the analytics relationship');
  assert(enforceKeyCustody({ ruleset: policy, audience: analyticsId.did, mintedBy: 'warden' }).ok, 'that satisfies the policy (default Warden)');

  process.stdout.write('\n▸ The Sovereign DECIDES WHEN — signs v2 to key the analytics relationship too\n');
  const policy2 = await signRuleset(sovereign, {
    actor: sovId.did,
    actorKind: 'sovereign',
    resource: 'key-custody',
    version: 2,
    previous: rulesetId(policy),
    capabilities: { keyCustody: { default: 'warden', subject: [bankId.did, analyticsId.did] } },
    ceiling: Sensitivity.SEALED,
    status: 'active',
  });
  assert(resolveKeyHolder(policy2, analyticsId.did) === 'subject', 'after v2, the Sovereign keys analytics itself');
  assert(!enforceKeyCustody({ ruleset: policy2, audience: analyticsId.did, mintedBy: 'warden' }).ok, 'the Warden is now refused from keying analytics too');

  process.stdout.write('\n▸ The DISCLOSURE chokepoint is wired — mintPairwiseGrant refuses a Warden-keyed disclosure to the bank\n');
  let disclosureRefused = false;
  try {
    await mintPairwiseGrant(warden, new MemoryPairwiseStore(), {
      audience: bankId.did,
      sovereignDid: sovId.did,
      createdAt: now,
      keyCustodyRuleset: policy, // the Sovereign's policy: the bank is subject-keyed
      activeRuleset: null,
      claim: 'unused — the guard fails closed first',
      evidence: [],
      txn: 'txn-keycustody',
    });
  } catch (e) {
    disclosureRefused = /key-custody/.test(e instanceof Error ? e.message : String(e));
  }
  assert(disclosureRefused, 'mintPairwiseGrant fails closed for the subject-keyed bank (the Warden cannot mint a disclosure identity for it)');
  // A non-subject-keyed audience still mints normally (back-compat) — sanity via resolveKeyHolder.
  assert(resolveKeyHolder(policy, analyticsId.did) === 'warden', 'a non-subject-keyed audience is unaffected — the Warden mints for it as before');

  process.stdout.write(
    "\n✓ Key custody is the Sovereign's SIGNED choice per relationship — not a category — and the Warden enforces it.\n",
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-finance-keycustody: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
