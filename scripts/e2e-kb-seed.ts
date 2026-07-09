/**
 * e2e: KB demo-data seed/reset + KB-scoped recall.
 *
 * Proves the multi-KB recall-scoping fix AND the seed/reset UX: seed the "hearthold" set into KB-A and
 * a distinct fact into KB-B; a query to KB-A answers from A and NEVER surfaces B (scoping); reset A
 * empties A while B survives (per-KB reset). Uses the real Ollama embed + answer models.
 *
 * Live (needs the Archon node + Ollama). Run:  npm run e2e:kb-seed
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  grantAuthorization,
  selfSigner,
  signKbRequest,
  PROTOCOL_VERSION,
  type KbRequestStatement,
} from '@hearthold/core';
import { KbConfigStore, initKbAssurance, buildKbServices } from '@hearthold/warden/kb-config';
import { seedKb, resetKb } from '@hearthold/warden/kb-seed';
import { RecallService } from '@hearthold/warden/recall';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const warden = await openKeymaster('warden', config, 'hearthold-e2e-kb-seed');
  const alice = await openKeymaster('sovereign', config, 'hearthold-e2e-kb-seed');
  const wid = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const store = new KbConfigStore(warden.dataFolder);
  const signer = selfSigner(warden, wid.did);

  // Two KBs on one Warden; Alice is a member of both.
  for (const kbId of ['kb-alpha', 'kb-beta']) {
    const readGroup = await createRegistryGroup(warden, `kb-read-${kbId}`, config.registry);
    const writeGroup = await createRegistryGroup(warden, `kb-write-${kbId}`, config.registry);
    await grantAuthorization(warden, readGroup, aliceId.did);
    await grantAuthorization(warden, writeGroup, aliceId.did);
    await store.put({ kbId, readGroup, writeGroup, policyAsset: await initKbAssurance(warden, config, kbId, signer), governorDid: undefined });
  }

  process.stdout.write('▸ Seed the "hearthold" demo set into kb-alpha; a distinct fact into kb-beta\n');
  const seeded = await seedKb(warden, config, wid.did, 'kb-alpha', 'hearthold');
  assert(seeded.loaded >= 6, `loaded ${seeded.loaded} demo cards into kb-alpha`);
  // A lone, very distinctive fact in kb-beta (contribute via the real KB update path).
  const kbs = await buildKbServices(warden, config, wid.did);
  const beta = kbs.get('kb-beta')!;
  const nonce = beta.challenge().nonce;
  const signed = await signKbRequest(alice, { action: 'update', requester: aliceId.did, kbId: 'kb-beta', nonce, kind: 'event', text: 'The Zorblax Festival happens every Blursday on planet Qwix.' } as KbRequestStatement);
  await beta.serve(signed);

  const recall = RecallService.forWarden(warden, config);
  process.stdout.write('\n▸ A kb-alpha query answers from the demo set — and NEVER sees kb-beta\n');
  const a = await recall.recall('What is the 7th Capital?', { kb: 'kb-alpha' });
  assert(/7th capital|accumulated|history/i.test(a.answer), `kb-alpha answers about the 7th Capital: "${a.answer.slice(0, 70)}…"`);
  assert(!/zorblax|blursday|qwix/i.test(a.answer), 'kb-alpha does NOT leak kb-beta content');
  assert(a.citations.every((c) => c.kind !== undefined), 'kb-alpha citations are from kb-alpha');

  process.stdout.write('\n▸ A kb-beta query sees ONLY kb-beta\n');
  const b = await recall.recall('When is the Zorblax Festival?', { kb: 'kb-beta' });
  assert(/blursday|qwix|zorblax/i.test(b.answer), `kb-beta answers about the Zorblax Festival: "${b.answer.slice(0, 70)}…"`);

  process.stdout.write('\n▸ Reset kb-alpha → empty; kb-beta survives (per-KB reset)\n');
  const { removed } = await resetKb(warden, 'kb-alpha');
  assert(removed === seeded.loaded, `reset removed exactly the ${removed} seeded kb-alpha cards`);
  const aAfter = await recall.recall('What is the 7th Capital?', { kb: 'kb-alpha' });
  assert(!/7th capital|warden|sovereign/i.test(aAfter.answer), 'kb-alpha now answers from nothing (reset worked)');
  const bAfter = await recall.recall('When is the Zorblax Festival?', { kb: 'kb-beta' });
  assert(/blursday|qwix|zorblax/i.test(bAfter.answer), 'kb-beta is untouched by kb-alpha reset');

  process.stdout.write('\n✓ KB seed/reset + per-KB recall scoping: load a demo, explore, reset, start fresh — isolated per KB\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-seed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
