/**
 * e2e: cantrip authorization — the Warden bounds a contained actor at its active Ruleset.
 *
 * A cantrip (or any contained actor) declares a Ruleset: which kinds, which verbs, up to what ceiling.
 * The Warden enforces it on every actor-originated request — the interpreter sandbox contains
 * computation; THIS is where the Warden contains disclosure. Proves: in-scope requests pass; out-of-
 * scope verb / kind / over-ceiling requests are refused; a revoked or unregistered actor is refused
 * (fail closed); and the Ruleset's assurance rides through for step-up.
 *
 * Live (needs the Archon node). Run:  npm run e2e:cantrip-auth
 */
import { loadConfig, openKeymaster, ensureIdentity, Sensitivity, type Ruleset } from '@hearthold/core';
import { RulesetStore } from '@hearthold/warden/ruleset-store';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const warden = await openKeymaster('warden', config, 'hearthold-e2e-cantrip-auth');
  await ensureIdentity(warden, config);
  const store = new RulesetStore(warden, config);

  const actor = 'cantrip:shelf-scan';
  // Its Ruleset: may read/propose over `location` up to LOW; a factor1 propose.
  const ruleset: Omit<Ruleset, 'version' | 'previous'> = {
    actor,
    actorKind: 'cantrip',
    capabilities: { kinds: ['location'], verbs: ['read', 'propose'], assurance: { propose: 'factor1' } },
    ceiling: Sensitivity.LOW,
    status: 'active',
  };
  await store.register(ruleset);
  process.stdout.write(`Registered ${actor}: kinds=[location] verbs=[read,propose] ceiling=LOW\n`);

  process.stdout.write('\n▸ In-scope requests pass\n');
  assert((await store.authorize(actor, { verb: 'read', kind: 'location', sensitivity: Sensitivity.LOW })).allowed, 'read location@LOW is allowed');
  const propose = await store.authorize(actor, { verb: 'propose', kind: 'location' });
  assert(propose.allowed && propose.requiredAssurance === 'factor1', 'propose is allowed and carries its factor1 assurance');

  process.stdout.write('\n▸ Out-of-scope requests are refused\n');
  assert(!(await store.authorize(actor, { verb: 'read', kind: 'document' })).allowed, "a kind not in the Ruleset ('document') is refused");
  assert(!(await store.authorize(actor, { verb: 'send' })).allowed, "a verb not in the Ruleset ('send') is refused");
  assert(!(await store.authorize(actor, { verb: 'read', kind: 'location', sensitivity: Sensitivity.HIGH })).allowed, 'a request above the ceiling (HIGH > LOW) is refused');

  process.stdout.write('\n▸ Unregistered + revoked actors are refused (fail closed)\n');
  assert(!(await store.authorize('cantrip:unknown', { verb: 'read' })).allowed, 'an unregistered actor authorizes nothing');
  await store.append(actor, { capabilities: {}, ceiling: 0, status: 'revoked' });
  assert(!(await store.authorize(actor, { verb: 'read', kind: 'location', sensitivity: Sensitivity.LOW })).allowed, 'a revoked actor authorizes nothing — the ceiling stops applying because the actor is off');

  process.stdout.write('\n✓ Cantrip auth: the Warden enforces the actor Ruleset (kinds · verbs · ceiling), fail closed\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-cantrip-auth: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
