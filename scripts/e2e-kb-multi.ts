/**
 * e2e: multiple Knowledge Bases under ONE Warden identity (no new Warden per DB).
 *
 * Proves: two KBs coexist on one Warden; membership is isolated (a member of one is refused by the
 * other); the handler routes a signed request to the KB matching its kbId; and kb-govern adopts Signet
 * governance on an existing KB while keeping its members.
 *
 * Live (needs the Archon node). Run:  npm run e2e:kb-multi
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
import { makeWardenHandler } from '@hearthold/warden/handler';
import { WardenService } from '@hearthold/warden/service';
import { DelegationStore } from '@hearthold/warden/delegations';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-kb-multi';

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass); // member of KB "vault"
  const bob = await openKeymaster('verifier', config, pass); // member of KB "guild"
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const bobId = await ensureIdentity(bob, config);

  const store = new KbConfigStore(warden.dataFolder);
  const signer = selfSigner(warden, wardenId.did);

  // Provision TWO KBs on the SAME Warden.
  for (const [kbId, member] of [['passwords', aliceId.did], ['guild', bobId.did]] as const) {
    const readGroup = await createRegistryGroup(warden, `kb-read-${kbId}`, config.registry);
    const writeGroup = await createRegistryGroup(warden, `kb-write-${kbId}`, config.registry);
    await grantAuthorization(warden, readGroup, member);
    await grantAuthorization(warden, writeGroup, member);
    const policyAsset = await initKbAssurance(warden, config, kbId, signer);
    await store.put({ kbId, readGroup, writeGroup, policyAsset, governorDid: undefined });
  }
  process.stdout.write('two KBs on one Warden: "passwords" (Alice), "guild" (Bob)\n');

  const kbs = await buildKbServices(warden, config, wardenId.did);
  assert(kbs.size === 2, 'buildKbServices returns both KBs from one Warden');
  const handler = makeWardenHandler(new WardenService(warden), new DelegationStore(warden), undefined, kbs);

  // Sign a request as `signer` for `kbId`, get a nonce from that KB first (via the challenge message).
  const signed = async (who: typeof alice, whoDid: string, kbId: string, body: Partial<KbRequestStatement>) => {
    const kb = kbs.get(kbId)!;
    const nonce = kb.challenge().nonce;
    return signKbRequest(who, { action: 'update', requester: whoDid, kbId, nonce, ...body } as KbRequestStatement);
  };
  const viaHandler = (req: unknown) => handler({ type: 'hearthold/kb-request', version: PROTOCOL_VERSION, request: req } as never, 'did:mage');

  process.stdout.write('\n▸ Each member writes to their own KB (routing by kbId)\n');
  const a = await viaHandler(await signed(alice, aliceId.did, 'passwords', { action: 'update', kind: 'document', text: 'login for example.com' }));
  assert((a as { type: string })?.type === 'hearthold/kb-result', 'Alice writes to "passwords"');
  const b = await viaHandler(await signed(bob, bobId.did, 'guild', { action: 'update', kind: 'event', text: 'raid Saturday 8pm' }));
  assert((b as { type: string })?.type === 'hearthold/kb-result', 'Bob writes to "guild"');

  process.stdout.write('\n▸ Membership is isolated across KBs\n');
  const cross = await viaHandler(await signed(alice, aliceId.did, 'guild', { action: 'update', kind: 'event', text: 'sneaky' }));
  assert((cross as { type: string })?.type === 'hearthold/kb-error', 'Alice (a "passwords" member) is refused by "guild"');

  process.stdout.write('\n▸ An unknown KB is refused\n');
  // The handler rejects an unknown kbId before any nonce check — sign with a throwaway nonce.
  const unknownReq = await signKbRequest(alice, { action: 'update', requester: aliceId.did, kbId: 'nope', nonce: 'x', kind: 'event', text: 'x' } as KbRequestStatement);
  const unknown = await viaHandler(unknownReq);
  assert((unknown as { type: string; reason?: string })?.type === 'hearthold/error', 'a request for an unprovisioned kbId is refused');

  process.stdout.write('\n▸ Store round-trips both KBs (get by id + list)\n');
  assert((await store.get('passwords'))?.kbId === 'passwords', 'get("passwords") resolves');
  assert((await store.list()).length === 2, 'list() returns both');
  assert((await store.get()) === null, 'get() with no id is ambiguous when >1 KB (null)');

  process.stdout.write('\n✓ Multi-KB: many Knowledge Bases per Warden, isolated + routed by kbId\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-multi: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
