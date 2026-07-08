/**
 * e2e: Ruleset chain primitives — the Sovereign-signed, versioned, append-only operating law.
 *
 * Builds a real chain (genesis → supersede → revoke), verifies it, resolves the operative head, and
 * proves the Warden refuses everything malformed: unsigned, wrong signer, broken previous link,
 * non-contiguous versions, and a tampered version.
 *
 * Live (needs the Archon node). Run:  npm run e2e:ruleset
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signRuleset,
  verifyRulesetChain,
  activeRuleset,
  rulesetId,
  Sensitivity,
  type Ruleset,
  type SignedRuleset,
} from '@hearthold/core';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-ruleset';

  const sovereign = await openKeymaster('sovereign', config, pass); // signs the law
  const warden = await openKeymaster('warden', config, pass); // enforces (verifies)
  const stranger = await openKeymaster('verifier', config, pass); // a different DID
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(warden, config);
  await ensureIdentity(stranger, config);

  const actor = 'cantrip:shelf-scan';
  const base: Omit<Ruleset, 'version' | 'previous' | 'status' | 'capabilities' | 'ceiling'> = {
    actor,
    actorKind: 'cantrip',
  };

  process.stdout.write('▸ Build + verify a signed chain (genesis → supersede)\n');
  const v1 = await signRuleset(sovereign, {
    ...base,
    version: 1,
    previous: null,
    capabilities: { kinds: ['location'], verbs: ['read', 'propose'], assurance: { write: 'factor2' } },
    ceiling: Sensitivity.LOW,
    status: 'active',
  });
  const v2 = await signRuleset(sovereign, {
    ...base,
    version: 2,
    previous: rulesetId(v1),
    capabilities: { kinds: ['location', 'document'], verbs: ['read', 'propose', 'send'], assurance: { write: 'factor2' } },
    ceiling: Sensitivity.MEDIUM,
    status: 'active',
  });
  assert((await verifyRulesetChain(warden, [v1])).ok, 'genesis chain verifies');
  assert((await verifyRulesetChain(warden, [v1, v2])).ok, 'two-version chain verifies (links + same signer)');
  const head = await activeRuleset(warden, [v1, v2]);
  assert(head?.version === 2 && head?.ceiling === Sensitivity.MEDIUM, 'the operative head is v2 (its ceiling governs)');
  assert((await verifyRulesetChain(warden, [v1, v2])).signer === sovId.did, 'the chain is signed by the Sovereign');

  process.stdout.write('\n▸ Revoke at the head → the actor is governed by nothing (fail closed)\n');
  const v3 = await signRuleset(sovereign, { ...base, version: 3, previous: rulesetId(v2), capabilities: {}, ceiling: 0, status: 'revoked' });
  assert((await verifyRulesetChain(warden, [v1, v2, v3])).ok, 'the chain (incl. a revoked head) still verifies structurally');
  assert((await activeRuleset(warden, [v1, v2, v3])) === null, 'a revoked head resolves to no operative Ruleset');

  process.stdout.write('\n▸ Malformed chains are refused\n');
  const unsigned = { ...base, version: 2, previous: rulesetId(v1), capabilities: {}, ceiling: 0, status: 'active' } as SignedRuleset;
  assert(!(await verifyRulesetChain(warden, [v1, unsigned])).ok, 'an unsigned version is refused');

  const wrongSigner = await signRuleset(stranger, { ...base, version: 2, previous: rulesetId(v1), capabilities: {}, ceiling: 0, status: 'active' });
  assert(!(await verifyRulesetChain(warden, [v1, wrongSigner])).ok, 'a version signed by a different DID is refused');

  const brokenLink = await signRuleset(sovereign, { ...base, version: 2, previous: 'deadbeef', capabilities: {}, ceiling: 0, status: 'active' });
  assert(!(await verifyRulesetChain(warden, [v1, brokenLink])).ok, 'a broken previous link is refused');

  assert(!(await verifyRulesetChain(warden, [v1, v3])).ok, 'a non-contiguous chain (v1 → v3) is refused');

  const tampered = { ...v1, ceiling: Sensitivity.SEALED } as SignedRuleset; // change after signing
  assert(!(await verifyRulesetChain(warden, [tampered])).ok, 'a version tampered after signing is refused');

  process.stdout.write('\n✓ Rulesets: Sovereign-signed, chained, one operative head; the Warden refuses unsigned/unchained/tampered\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-ruleset: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
