/**
 * e2e: KB web login via challenge/response + sessions (keys stay in the member's wallet / the Signet).
 *
 * The archon.social/login model applied to the KB. The Warden issues a challenge; the member's wallet
 * (here the sovereign CLI, standing in for the Signet) `createResponse`s it — proving DID control
 * without the key ever leaving the wallet; the Warden `verifyResponse`s and mints a short-lived
 * session. Subsequent KB ops ride the session. Negatives: bad/expired session, and a non-member who
 * authenticates but is refused at the op.
 *
 * Live (needs the Archon node + Ollama). Run:  npm run e2e:kb-login
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  grantAuthorization,
  GroupTrustRegistry,
  PROTOCOL_VERSION,
  type KbSessionRequestMessage,
} from '@hearthold/core';
import { KbService } from '@hearthold/warden/kb';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-kb-login';
  const kbId = 'guild-kb-login';

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass); // a member (acts as the Signet)
  const bob = await openKeymaster('verifier', config, pass); // authenticates, but not a member
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const bobId = await ensureIdentity(bob, config);

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
  const kb = new KbService(warden, config, { kbId, wardenDid: wardenId.did, registry });
  process.stdout.write(`KB "${kbId}" provisioned; Alice granted, Bob not\n`);

  // The member's wallet/Signet logs in: get a challenge, createResponse (key never leaves), get a session.
  const login = async (member: typeof alice): Promise<string> => {
    const challenge = await kb.startLogin(kbId, 'https://mage.example/api/kb/login/callback');
    const responseDID = await member.keymaster.createResponse(challenge);
    const session = await kb.completeLogin(responseDID);
    if (session.type !== 'hearthold/kb-session') throw new Error(`login failed: ${JSON.stringify(session)}`);
    return session.token;
  };

  const sreq = (token: string, body: Partial<KbSessionRequestMessage>): KbSessionRequestMessage => ({
    type: 'hearthold/kb-session-request',
    version: PROTOCOL_VERSION,
    token,
    kbId,
    action: 'query',
    ...body,
  });

  process.stdout.write('\n▸ Member logs in via challenge/response (key stays in the wallet)\n');
  const aliceToken = await login(alice);
  assert(typeof aliceToken === 'string' && aliceToken.length > 0, 'Alice authenticates and gets a session token');

  process.stdout.write('\n▸ Session-authenticated contribute + ask\n');
  const upd = await kb.serveWithSession(
    sreq(aliceToken, { action: 'update', kind: 'event', text: 'The guild AGM is Thursday July 23 at 6pm.' }),
  );
  assert(upd.type === 'hearthold/kb-result' && upd.action === 'update', 'Alice contributes over her session');
  const q = await kb.serveWithSession(sreq(aliceToken, { action: 'query', query: 'When is the AGM?' }));
  if (q.type !== 'hearthold/kb-result' || q.action !== 'query') throw new Error(`expected query result: ${JSON.stringify(q)}`);
  assert(/thursday|july 23|6pm/i.test(q.answer), `the KB answers over the session: "${q.answer}"`);

  process.stdout.write('\n▸ Bad / forged session is refused\n');
  const bogus = await kb.serveWithSession(sreq('deadbeef-not-a-real-token', { action: 'query', query: 'AGM?' }));
  assert(bogus.type === 'hearthold/kb-error', 'an unknown session token is refused');

  process.stdout.write('\n▸ A non-member authenticates but is refused at the op (authN ≠ authZ)\n');
  const bobToken = await login(bob);
  assert(typeof bobToken === 'string', 'Bob can authenticate (prove DID control)');
  const bobTry = await kb.serveWithSession(sreq(bobToken, { action: 'query', query: 'AGM?' }));
  assert(bobTry.type === 'hearthold/kb-error', 'but Bob (not a member) is refused the query');

  process.stdout.write('\n✓ KB login: challenge → response (key in wallet) → session → authorized ops; the Warden authenticates, the Mage would only carry\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-login: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
