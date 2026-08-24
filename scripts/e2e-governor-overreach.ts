/**
 * e2e: governor overreach — the amendment rule (guardianship-threat-model.md §3). THE headline test of
 * the family arc: guardianship is grantable but never seizable.
 *
 * A governor-signed Ruleset transition that WIDENS the governor's reach into a member's PRIVATE scope is
 * invalid unless that member's own acknowledgment signature is in the transition — otherwise the operative
 * head fails closed to the prior version. A governor cannot rewrite the constitution over a member's head.
 *
 * Live (needs the Archon node for signing + verification). Run:  npm run e2e:governor-overreach
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signRuleset,
  signMemberAck,
  operativeRuleset,
  widensIntoPrivateScope,
  rulesetId,
  Sensitivity,
  type Ruleset,
  type SignedRuleset,
} from '@hearthold/core';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-overreach';

  const warden = await openKeymaster('warden', config, pass); // the chain verifier
  const governor = await openKeymaster('sovereign', config, pass); // the Master-Sovereign
  const member = await openKeymaster('verifier', config, pass); // member M (the watched)
  const stranger = await openKeymaster('registry', config, pass); // a different member
  const wardenId = await ensureIdentity(warden, config);
  const gov = (await ensureIdentity(governor, config)).did;
  const M = (await ensureIdentity(member, config)).did;
  const other = (await ensureIdentity(stranger, config)).did;

  const pin = { expectedSigner: gov };
  const headV = async (chain: SignedRuleset[]): Promise<number | null> => (await operativeRuleset(warden, chain, pin))?.version ?? null;

  // Genesis: a benign household Ruleset (no guardianship). Governor-signed.
  const v1base: Ruleset = { actor: gov, actorKind: 'household', resource: 'home', version: 1, previous: null, capabilities: {}, ceiling: Sensitivity.LOW, status: 'active' };
  const v1 = await signRuleset(governor, v1base);
  assert((await headV([v1])) === 1, 'genesis v1 is the operative head');

  // A guardianship v2: the governor grants THEMSELVES read into member M's private location scope.
  const v2base: Ruleset = {
    actor: gov, actorKind: 'household', resource: 'home', version: 2, previous: rulesetId(v1),
    capabilities: { kinds: ['location'], verbs: ['read'] }, ceiling: Sensitivity.MEDIUM, status: 'active', subject: M,
  };
  assert(widensIntoPrivateScope(v1base, v2base) === true, 'v2 is classified as access-widening into M’s private scope');

  process.stdout.write('\n▸ THE HEADLINE — seizure attempt (no member signature)\n');
  const v2seizure = await signRuleset(governor, v2base); // governor signs alone, no member ack
  assert((await headV([v1, v2seizure])) === 1, 'governor-signed widening WITHOUT M’s ack → REJECTED, Warden serves v1 (never seizable)');

  process.stdout.write('\n▸ Guardianship — granted with the member’s own signature\n');
  const v2granted: SignedRuleset = { ...v2seizure, memberAck: await signMemberAck(member, v2seizure) };
  assert((await headV([v1, v2granted])) === 2, 'the SAME widening WITH M’s acknowledgment → accepted (grantable)');

  process.stdout.write('\n▸ A governor cannot forge consent with someone else’s key\n');
  const v2forged: SignedRuleset = { ...v2seizure, memberAck: await signMemberAck(stranger, v2seizure) };
  assert((await headV([v1, v2forged])) === 1, 'a NON-subject’s signature does not satisfy the ack → serves v1');

  process.stdout.write('\n▸ Non-guardianship changes stay governor-domain (no member ack needed)\n');
  const v2sharedBase: Ruleset = { actor: gov, actorKind: 'household', resource: 'home', version: 2, previous: rulesetId(v1), capabilities: { kinds: ['document'], verbs: ['read'] }, ceiling: Sensitivity.LOW, status: 'active' };
  assert(widensIntoPrivateScope(v1base, v2sharedBase) === false, 'a shared-policy change is NOT access-widening');
  const v2shared = await signRuleset(governor, v2sharedBase);
  assert((await headV([v1, v2shared])) === 2, 'a governor-domain amendment is accepted governor-signed alone');

  process.stdout.write('\n▸ Forged history — a broken hash link fails closed to the prior version\n');
  const v2badlink: SignedRuleset = { ...v2granted, previous: 'sha256:deadbeef' };
  assert((await headV([v1, v2badlink])) === 1, 'a tampered `previous` link breaks the chain → serves v1');

  process.stdout.write('\n▸ Governor pinning — a chain not signed by the household’s governor governs nothing\n');
  assert((await operativeRuleset(warden, [v1, v2granted], { expectedSigner: other })) === null, 'wrong expected governor → no operative Ruleset (fail closed)');

  process.stdout.write('\n✓ Amendment rule: guardianship is grantable (with the member’s key) but never seizable (without it)\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-governor-overreach: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
