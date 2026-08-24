/**
 * e2e: the Knowledge Portal first increment (KB via a public Mage + a private Warden).
 *
 * A KB Warden serves a shared Knowledge Base. An authorized member (Sovereign-A) authenticates by
 * signing a request over the Warden's nonce (proves DID control, end-to-end), is authorized by a
 * trust-registry group, and updates + queries the KB. The negatives hold: a non-member (Sovereign-B)
 * is refused, a forged requester is rejected (authentication), and a replayed nonce is rejected. The
 * public Mage relay is exercised as a pure forwarder.
 *
 * Live (needs the Archon node + Ollama). Run:  npm run e2e:kb
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  grantAuthorization,
  GroupTrustRegistry,
  signKbRequest,
  PROTOCOL_VERSION,
  type KbRequestStatement,
  type SignedKbRequest,
  type HearthholdMessage,
  type Transport,
} from '@hearthold/core';
import { KbService } from '@hearthold/warden/kb';
import { makeKbRelayHandler } from '@hearthold/emissary/kb-relay';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-kb';
  const kbId = 'drake-gamers-guild-kb';

  const warden = await openKeymaster('warden', config, pass); // the KB Warden
  const alice = await openKeymaster('sovereign', config, pass); // an authorized member
  const bob = await openKeymaster('verifier', config, pass); // a non-member
  const mage = await openKeymaster('emissary', config, pass); // the public Mage (portal)
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const bobId = await ensureIdentity(bob, config);
  await ensureIdentity(mage, config);

  // KB access groups: read + write on the KB resource. Alice is granted both; Bob nothing.
  const readGroup = await createRegistryGroup(warden, `kb-read-${kbId}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${kbId}`, config.registry);
  await grantAuthorization(warden, readGroup, aliceId.did);
  await grantAuthorization(warden, writeGroup, aliceId.did);
  const registry = new GroupTrustRegistry(
    warden,
    [
      { action: 'read', resource: kbId, group: readGroup },
      { action: 'write', resource: kbId, group: writeGroup },
    ],
    wardenId.did,
  );
  process.stdout.write(`KB "${kbId}" provisioned; Alice granted read+write, Bob nothing\n`);

  const kb = new KbService(warden, config, { kbId, wardenDid: wardenId.did, registry });

  // Helper: a member gets a nonce, signs a statement, and serves it (the Mage-relayed round-trip).
  const signed = async (
    signer: typeof alice,
    signerDid: string,
    body: Partial<KbRequestStatement>,
  ): Promise<SignedKbRequest> => {
    const nonce = kb.challenge().nonce;
    return signKbRequest(signer, {
      action: 'query',
      requester: signerDid,
      kbId,
      nonce,
      ...body,
    } as KbRequestStatement);
  };

  process.stdout.write('\n▸ Authorized member updates the KB\n');
  const upd = await kb.serve(
    await signed(alice, aliceId.did, {
      action: 'update',
      kind: 'event',
      text: 'The Drake Gamers Guild summer raid is Saturday July 11 at 8pm server time.',
    }),
  );
  assert(upd.type === 'hearthold/kb-result' && upd.action === 'update', 'Alice (write-authorized) updates the KB');

  process.stdout.write('\n▸ Authorized member queries the KB (recall over the shared KB)\n');
  const q = await kb.serve(await signed(alice, aliceId.did, { action: 'query', query: 'When is the sphere raid?' }));
  if (q.type !== 'hearthold/kb-result' || q.action !== 'query') throw new Error(`expected query result, got ${JSON.stringify(q)}`);
  assert(/saturday|july 11|8pm/i.test(q.answer), `the KB answers from the contributed knowledge: "${q.answer}"`);
  assert((q.citations?.length ?? 0) >= 1, 'the answer carries at least one citation');

  process.stdout.write('\n▸ Non-member is refused (authorization)\n');
  const bobTry = await kb.serve(await signed(bob, bobId.did, { action: 'query', query: 'When is the sphere raid?' }));
  assert(bobTry.type === 'hearthold/kb-error', 'Bob (not a member) is refused a query');

  process.stdout.write('\n▸ Forged requester is rejected (authentication)\n');
  const nonce = kb.challenge().nonce;
  // Bob signs but claims to be Alice.
  const forged = await signKbRequest(bob, { action: 'query', requester: aliceId.did, kbId, nonce, query: 'raid?' });
  const forgedTry = await kb.serve(forged);
  assert(forgedTry.type === 'hearthold/kb-error', 'a request signed by the wrong DID is rejected');

  process.stdout.write('\n▸ Replayed nonce is rejected (anti-replay)\n');
  const fresh = kb.challenge().nonce;
  const once = await signKbRequest(alice, { action: 'query', requester: aliceId.did, kbId, nonce: fresh, query: 'raid?' });
  const first = await kb.serve(once);
  assert(first.type === 'hearthold/kb-result', 'first use of the nonce succeeds');
  const replay = await kb.serve(once);
  assert(replay.type === 'hearthold/kb-error', 'reusing the same signed request (nonce) is rejected');

  process.stdout.write('\n▸ The public Mage relay forwards KB traffic (holds nothing, decides nothing)\n');
  const fakeTransport: Transport = {
    ready: async () => {},
    serve: async () => () => {},
    request: async (toDid, message) => {
      assert(toDid === wardenId.did, 'the Mage relays to the Warden DID');
      if (message.type === 'hearthold/kb-challenge-request') return kb.challenge() as HearthholdMessage;
      if (message.type === 'hearthold/kb-request') return (await kb.serve((message as { request: SignedKbRequest }).request)) as HearthholdMessage;
      return { type: 'hearthold/kb-error', version: PROTOCOL_VERSION, reason: 'unexpected' };
    },
  };
  const relay = makeKbRelayHandler(fakeTransport, wardenId.did);
  const ch = await relay({ type: 'hearthold/kb-challenge-request', version: PROTOCOL_VERSION, kbId }, mage ? 'did:mage' : '');
  assert(ch?.type === 'hearthold/kb-challenge', 'the relay carries the Warden challenge back');
  const relayNonce = (ch as { nonce: string }).nonce;
  const relayed = await relay(
    {
      type: 'hearthold/kb-request',
      version: PROTOCOL_VERSION,
      request: await signKbRequest(alice, { action: 'query', requester: aliceId.did, kbId, nonce: relayNonce, query: 'raid?' }),
    },
    'did:mage',
  );
  assert(relayed?.type === 'hearthold/kb-result', 'a signed request relayed by the Mage is served');

  process.stdout.write('\n✓ Knowledge Portal: authenticate (signed) → authorize (group) → query/update; Mage only carries\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
