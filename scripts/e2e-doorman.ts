/**
 * e2e: the Doorman (`auth:web`) Emissary skill — public web-authentication with the split that lets a
 * SEALED-node custodian admit an external member it could never resolve.
 *
 * The point being proven: the challenge/response is minted and verified by the EMISSARY's own keymaster
 * (authentication moves to the public, world-facing agent), while the Warden supplies only the membership
 * verdict (`authorizeCheck` — a pure `testGroup` on the DID string, no resolution). We drive the real
 * doorman module's route handlers against a real Warden `KbService` and real `did:cid` identities; the
 * HTTP/DIDComm transport is omitted because it carries nothing the security argument depends on.
 *
 *   David (member)   authenticates via the DOORMAN → authorized by the Warden → reads the shared corpus.
 *   Mallory (non-member) authenticates fine → REFUSED at the Warden gate → never reaches the corpus.
 *   The membership probe itself is gated: a caller not read-authorized on the KB gets `false`, always.
 *
 * Live (needs the Archon node + Ollama). Run:  npm run e2e:doorman
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
import { doormanModule, type DoormanDeps } from '@hearthold/emissary/modules/doorman';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

// Invoke a module route handler the way the control server would (no HTTP needed).
type RouteMap = NonNullable<ReturnType<typeof doormanModule>['httpRoutes']>;
const call = (routes: RouteMap, key: string, ctx: { body?: unknown; query?: Record<string, string> } = {}): Promise<unknown> =>
  Promise.resolve(routes[key]!({ body: ctx.body, query: new URLSearchParams(ctx.query ?? {}), req: {} as never }));

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-doorman';
  const kbId = 'doorman-kb';

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass); // the DOORMAN — authenticates visitors itself
  const david = await openKeymaster('sovereign', config, pass); // an authorized member (the visitor)
  const mallory = await openKeymaster('verifier', config, pass); // authenticates, but is not a member
  const wardenId = await ensureIdentity(warden, config);
  const emissaryId = await ensureIdentity(emissary, config);
  const davidId = await ensureIdentity(david, config);
  const malloryId = await ensureIdentity(mallory, config);

  const readGroup = await createRegistryGroup(warden, `kb-read-${kbId}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${kbId}`, config.registry);
  // The doorman (Emissary) holds its OWN read authority — that is how it serves the shared corpus, and it is
  // what makes it a trusted caller for the membership probe. It also curates (write) to seed the corpus here.
  await grantAuthorization(warden, readGroup, emissaryId.did);
  await grantAuthorization(warden, writeGroup, emissaryId.did);
  // David is an authorized READER — but his identity is exactly the kind a sealed Warden might not resolve.
  await grantAuthorization(warden, readGroup, davidId.did);
  // Mallory gets nothing.

  const registry = new GroupTrustRegistry(
    warden,
    [
      { action: 'read', resource: kbId, group: readGroup },
      { action: 'write', resource: kbId, group: writeGroup },
    ],
    wardenId.did,
  );
  const kb = new KbService(warden, config, { kbId, wardenDid: wardenId.did, registry });
  process.stdout.write(`KB "${kbId}" provisioned; doorman=Emissary (read+write), David (read), Mallory (none)\n`);

  // The Emissary logs itself in (its own read session) and seeds the shared corpus it will later serve.
  const emissaryLogin = async (): Promise<string> => {
    const challenge = await kb.startLogin(kbId, 'https://agency.example/api/door/ask');
    const responseDID = await emissary.keymaster.createResponse(challenge, { registry: config.registry });
    const session = await kb.completeLogin(responseDID);
    if (session.type !== 'hearthold/kb-session') throw new Error(`emissary login failed: ${JSON.stringify(session)}`);
    return session.token;
  };
  const emToken = await emissaryLogin();
  const seed = await kb.serveWithSession({
    type: 'hearthold/kb-session-request',
    version: PROTOCOL_VERSION,
    token: emToken,
    kbId,
    action: 'update',
    kind: 'document',
    text: 'The Architecture of Agency holds that autonomy is the capacity to author one’s own constraints.',
    scope: 'shared',
  } as KbSessionRequestMessage);
  assert(seed.type === 'hearthold/kb-result', 'the doorman seeds the SHARED corpus (as a curator)');

  // ── The doorman skill, wired to the real Warden + the Emissary's own keymaster ──
  const deps: DoormanDeps = {
    kbId,
    publicUrl: 'https://agency.example',
    // AUTHENTICATION — minted + verified by the EMISSARY, not the Warden. This is the whole move.
    createChallenge: ({ callback, kbId: kb2 }) =>
      (emissary.keymaster.createChallenge as (c?: Record<string, unknown>, o?: Record<string, unknown>) => Promise<string>)(
        { callback, kbId: kb2 },
        { registry: config.registry },
      ),
    verifyResponse: async (r) => {
      const res = await (emissary.keymaster.verifyResponse as (r: string) => Promise<{ match?: boolean; responder?: string }>)(r);
      return { match: res.match === true, ...(res.responder ? { responder: res.responder } : {}) };
    },
    // AUTHORIZATION — the Warden's pure membership verdict (no resolution). The doorman (emissaryId) is the caller.
    authorizeSubject: async (subjectDid) => (await kb.authorizeCheck(emissaryId.did, subjectDid)).authorized,
    // SERVE — the doorman's own shared-scope read session.
    serveShared: async (query, k) => {
      const token = await emissaryLogin();
      const reply = await kb.serveWithSession({
        type: 'hearthold/kb-session-request',
        version: PROTOCOL_VERSION,
        token,
        kbId,
        action: 'query',
        query,
        k: k ?? 5,
        scope: 'shared',
      });
      if (reply.type !== 'hearthold/kb-result' || reply.action !== 'query') throw new Error(`serve failed: ${JSON.stringify(reply)}`);
      return { answer: reply.answer, citations: reply.citations.filter((c) => c.scope !== 'private') };
    },
  };
  const routes = doormanModule(deps).httpRoutes!;

  // Drive one visitor login through the doorman with the visitor's REAL createResponse.
  const visit = async (visitor: typeof david): Promise<{ accepted: boolean; reason?: string; token?: string }> => {
    const start = (await call(routes, 'POST /api/door/login/start')) as { loginId: string; challenge: string };
    const responseDID = await visitor.keymaster.createResponse(start.challenge, { registry: config.registry });
    const cb = (await call(routes, 'POST /api/door/login/callback', { body: { response: responseDID }, query: { login: start.loginId } })) as {
      accepted: boolean;
      reason?: string;
    };
    if (!cb.accepted) return cb;
    const poll = (await call(routes, 'GET /api/door/login/poll', { query: { login: start.loginId } })) as { status: string; token?: string };
    return { accepted: true, ...(poll.token ? { token: poll.token } : {}) };
  };

  process.stdout.write('\n▸ David (member) is authenticated BY THE EMISSARY, then authorized by the Warden\n');
  const davidVisit = await visit(david);
  assert(davidVisit.accepted && !!davidVisit.token, 'David passes the door — authn (Emissary) + authz (Warden)');
  const ask = (await call(routes, 'POST /api/door/ask', { body: { token: davidVisit.token, query: 'What is autonomy?' } })) as {
    answer: string;
    citations: unknown[];
  };
  assert(/constraint|author|autonom/i.test(ask.answer), `David reads the shared corpus: "${ask.answer.slice(0, 80)}…"`);

  process.stdout.write('\n▸ Mallory authenticates fine, but is REFUSED at the Warden gate (authN ≠ authZ)\n');
  const malloryVisit = await visit(mallory);
  assert(malloryVisit.accepted === false, 'Mallory proves DID control (real signature)…');
  assert(/not an authorized member/i.test(malloryVisit.reason ?? ''), '…but is refused: not a member — no session, no corpus');

  process.stdout.write('\n▸ The membership probe is itself gated — an untrusted caller learns nothing\n');
  const probeByMallory = await kb.authorizeCheck(malloryId.did, davidId.did);
  assert(probeByMallory.authorized === false, 'a caller not read-authorized on the KB gets `false` even for a real member');
  const probeByDoorman = await kb.authorizeCheck(emissaryId.did, davidId.did);
  assert(probeByDoorman.authorized === true, 'the doorman (read-authorized) gets the true verdict');

  process.stdout.write(
    '\n✓ Doorman: the Emissary authenticates the visitor with its OWN keymaster; the sealed Warden only ' +
      'authorizes (pure membership, no resolution) and serves the shared corpus. The custodian never faced the public.\n',
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-doorman: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
