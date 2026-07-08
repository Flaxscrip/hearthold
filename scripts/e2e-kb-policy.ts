/**
 * e2e: the KB assurance policy converged onto a Sovereign-signed Ruleset chain.
 *
 * The old mechanism was a bare, mutable, UNSIGNED asset — anyone who could rewrite it could silently
 * downgrade the requirement. The converged mechanism is a signed chain the Warden verifies: a tampered
 * chain **fails closed** (resolves to the strongest tier, never the attacker's downgrade), a revoked
 * head drops to base, and appended versions govern by their active head.
 *
 * Live (needs the Archon node). Run:  npm run e2e:kb-policy
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signRuleset,
  rulesetId,
  RulesetAssurancePolicy,
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
  const warden = await openKeymaster('warden', config, 'hearthold-e2e-kb-policy');
  await ensureIdentity(warden, config);
  const kbId = 'policy-kb';

  const mkRuleset = (version: number, previous: string | null, assurance: Record<string, 'factor1' | 'factor2'>, status: Ruleset['status'] = 'active'): Ruleset => ({
    actor: kbId,
    actorKind: 'kb',
    resource: kbId,
    version,
    previous,
    capabilities: { assurance },
    ceiling: Sensitivity.SEALED,
    status,
  });
  const anchor = (chain: SignedRuleset[]): Promise<string> => warden.keymaster.createAsset(chain, { registry: config.registry });
  const required = (asset: string, action: string) => new RulesetAssurancePolicy(warden, asset).requiredAssurance(action);

  process.stdout.write('▸ A signed policy governs\n');
  const v1 = await signRuleset(warden, mkRuleset(1, null, { read: 'factor1', write: 'factor2' }));
  const signedAsset = await anchor([v1]);
  assert((await required(signedAsset, 'write')) === 'factor2', 'signed policy: write requires factor2');
  assert((await required(signedAsset, 'read')) === 'factor1', 'signed policy: read is factor1');

  process.stdout.write('\n▸ Tampering to DOWNGRADE fails closed (the whole point of signing)\n');
  const tampered = { ...v1, capabilities: { assurance: { read: 'factor1', write: 'factor1' } } } as SignedRuleset; // downgrade write, keep old proof
  const tamperedAsset = await anchor([tampered]);
  assert((await required(tamperedAsset, 'write')) === 'factor2', 'tampered chain does NOT downgrade — resolves to factor2 (fail closed)');

  process.stdout.write('\n▸ Append a version (raise read to factor2)\n');
  const v2 = await signRuleset(warden, mkRuleset(2, rulesetId(v1), { read: 'factor2', write: 'factor2' }));
  const appended = await anchor([v1, v2]);
  assert((await required(appended, 'read')) === 'factor2', 'the active head governs: read now factor2');

  process.stdout.write('\n▸ Revoke the head → back to base (no step-up)\n');
  const v3 = await signRuleset(warden, mkRuleset(3, rulesetId(v2), {}, 'revoked'));
  const revoked = await anchor([v1, v2, v3]);
  assert((await required(revoked, 'write')) === 'factor1', 'a revoked head drops the requirement to base factor1');

  process.stdout.write('\n✓ Assurance policy = signed Ruleset chain: tamper-evident, fail-closed on downgrade, one converged mechanism\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-policy: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
