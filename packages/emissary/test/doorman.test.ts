/**
 * Unit tests for the Doorman (`auth:web`) Emissary skill — the public web-authenticator.
 *
 * Everything the module DEPENDS on is injected (authenticate with the Emissary's keymaster, authorize at the
 * Warden, serve the shared corpus), so these tests drive the login/session state machine with stubs and no
 * live node. The security-load-bearing behaviours: authentication AND authorization must BOTH pass before a
 * session is minted; an unauthorized (but validly-signed) visitor is refused at the Warden gate and never
 * reaches `serveShared`; a query needs a live, unexpired session. Pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import { doormanModule, type DoormanDeps } from '../src/modules/doorman.ts';

type RouteMap = NonNullable<ReturnType<typeof doormanModule>['httpRoutes']>;
const call = (routes: RouteMap, key: string, ctx: { body?: unknown; query?: Record<string, string> } = {}) => {
  const h = routes[key];
  if (!h) throw new Error(`no route ${key}`);
  return h({ body: ctx.body, query: new URLSearchParams(ctx.query ?? {}), req: {} as IncomingMessage });
};

const DAVID = 'did:cid:david';

interface Spies {
  createChallengeCalls: { callback: string; kbId: string }[];
  verifyCalls: string[];
  authorizeCalls: string[];
  serveCalls: { query: string; k?: number }[];
}

function makeDeps(opts: {
  verify?: (r: string) => { match: boolean; responder?: string };
  authorized?: boolean;
  now?: () => number;
  sessionTtlMs?: number;
}): { deps: DoormanDeps; spies: Spies } {
  const spies: Spies = { createChallengeCalls: [], verifyCalls: [], authorizeCalls: [], serveCalls: [] };
  const deps: DoormanDeps = {
    kbId: 'agency',
    publicUrl: 'https://agency.example',
    async createChallenge(input) {
      spies.createChallengeCalls.push(input);
      return `did:cid:challenge#${spies.createChallengeCalls.length}`;
    },
    async verifyResponse(r) {
      spies.verifyCalls.push(r);
      return (opts.verify ?? (() => ({ match: true, responder: DAVID })))(r);
    },
    async authorizeSubject(subjectDid) {
      spies.authorizeCalls.push(subjectDid);
      return opts.authorized ?? true;
    },
    async serveShared(query, k) {
      spies.serveCalls.push({ query, ...(k !== undefined ? { k } : {}) });
      return { answer: `answer:${query}`, citations: [{ id: 'c1' }] };
    },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.sessionTtlMs ? { sessionTtlMs: opts.sessionTtlMs } : {}),
  };
  return { deps, spies };
}

test('the module registers as auth:web with the four door routes', () => {
  const { deps } = makeDeps({});
  const mod = doormanModule(deps);
  assert.equal(mod.name, 'auth:web');
  assert.deepEqual(Object.keys(mod.httpRoutes ?? {}).sort(), [
    'GET /api/door/login/poll',
    'POST /api/door/ask',
    'POST /api/door/login/callback',
    'POST /api/door/login/start',
  ]);
});

test('login/start mints a challenge with the Emissary keymaster, callback carries the loginId', async () => {
  const { deps, spies } = makeDeps({});
  const routes = doormanModule(deps).httpRoutes!;
  const out = (await call(routes, 'POST /api/door/login/start')) as { loginId: string; challenge: string; kbId: string };
  assert.ok(out.loginId && out.challenge);
  assert.equal(out.kbId, 'agency');
  assert.equal(spies.createChallengeCalls.length, 1);
  assert.equal(spies.createChallengeCalls[0]!.kbId, 'agency');
  assert.match(spies.createChallengeCalls[0]!.callback, new RegExp(`login=${out.loginId}$`));
});

test('happy path: authenticated + authorized → session minted → ask serves the shared corpus', async () => {
  const { deps, spies } = makeDeps({ authorized: true });
  const routes = doormanModule(deps).httpRoutes!;
  const { loginId } = (await call(routes, 'POST /api/door/login/start')) as { loginId: string };

  const cb = (await call(routes, 'POST /api/door/login/callback', { body: { response: 'did:cid:resp' }, query: { login: loginId } })) as { accepted: boolean };
  assert.equal(cb.accepted, true);
  assert.deepEqual(spies.verifyCalls, ['did:cid:resp']); // authenticated with the Emissary's keymaster
  assert.deepEqual(spies.authorizeCalls, [DAVID]); // authorized at the Warden, by the AUTHENTICATED did

  const poll = (await call(routes, 'GET /api/door/login/poll', { query: { login: loginId } })) as { status: string; token?: string };
  assert.equal(poll.status, 'ready');
  assert.ok(poll.token);

  const ask = (await call(routes, 'POST /api/door/ask', { body: { token: poll.token, query: 'what is agency?', k: 3 } })) as { answer: string; citations: unknown[] };
  assert.equal(ask.answer, 'answer:what is agency?');
  assert.deepEqual(spies.serveCalls, [{ query: 'what is agency?', k: 3 }]);
});

test('the login is one-shot: a second poll after ready returns unknown', async () => {
  const { deps } = makeDeps({});
  const routes = doormanModule(deps).httpRoutes!;
  const { loginId } = (await call(routes, 'POST /api/door/login/start')) as { loginId: string };
  await call(routes, 'POST /api/door/login/callback', { body: { response: 'r' }, query: { login: loginId } });
  const first = (await call(routes, 'GET /api/door/login/poll', { query: { login: loginId } })) as { status: string };
  assert.equal(first.status, 'ready');
  const second = (await call(routes, 'GET /api/door/login/poll', { query: { login: loginId } })) as { status: string };
  assert.equal(second.status, 'unknown');
});

test('a response that does NOT verify is refused, and never reaches the Warden or the corpus', async () => {
  const { deps, spies } = makeDeps({ verify: () => ({ match: false }) });
  const routes = doormanModule(deps).httpRoutes!;
  const { loginId } = (await call(routes, 'POST /api/door/login/start')) as { loginId: string };
  const cb = (await call(routes, 'POST /api/door/login/callback', { body: { response: 'forged' }, query: { login: loginId } })) as { accepted: boolean; reason?: string };
  assert.equal(cb.accepted, false);
  assert.match(cb.reason ?? '', /did not verify/);
  assert.equal(spies.authorizeCalls.length, 0, 'no membership probe for an unauthenticated response');
  assert.equal(spies.serveCalls.length, 0);
  const poll = (await call(routes, 'GET /api/door/login/poll', { query: { login: loginId } })) as { status: string };
  assert.equal(poll.status, 'denied');
});

test('AUTHENTICATED but UNAUTHORIZED (not a member) → refused at the Warden gate, no session, no serve', async () => {
  const { deps, spies } = makeDeps({ verify: () => ({ match: true, responder: 'did:cid:mallory' }), authorized: false });
  const routes = doormanModule(deps).httpRoutes!;
  const { loginId } = (await call(routes, 'POST /api/door/login/start')) as { loginId: string };
  const cb = (await call(routes, 'POST /api/door/login/callback', { body: { response: 'ok-sig' }, query: { login: loginId } })) as { accepted: boolean; reason?: string };
  assert.equal(cb.accepted, false);
  assert.match(cb.reason ?? '', /not an authorized member/);
  assert.deepEqual(spies.authorizeCalls, ['did:cid:mallory'], 'the Warden was asked — and said no');
  assert.equal(spies.serveCalls.length, 0, 'a valid signature is not enough — membership decides');
  const poll = (await call(routes, 'GET /api/door/login/poll', { query: { login: loginId } })) as { status: string };
  assert.equal(poll.status, 'denied');
});

test('ask requires a live session: unknown token and expired session both refuse', async () => {
  let clock = 1000;
  const { deps } = makeDeps({ now: () => clock, sessionTtlMs: 1000 });
  const routes = doormanModule(deps).httpRoutes!;

  await assert.rejects(() => Promise.resolve(call(routes, 'POST /api/door/ask', { body: { token: 'nope', query: 'q' } })), /unknown session/);

  const { loginId } = (await call(routes, 'POST /api/door/login/start')) as { loginId: string };
  await call(routes, 'POST /api/door/login/callback', { body: { response: 'r' }, query: { login: loginId } });
  const poll = (await call(routes, 'GET /api/door/login/poll', { query: { login: loginId } })) as { token: string };

  clock = 5000; // past the 1000ms TTL
  await assert.rejects(() => Promise.resolve(call(routes, 'POST /api/door/ask', { body: { token: poll.token, query: 'q' } })), /expired/);
});

test('ask rejects an empty query before serving', async () => {
  const { deps, spies } = makeDeps({});
  const routes = doormanModule(deps).httpRoutes!;
  const { loginId } = (await call(routes, 'POST /api/door/login/start')) as { loginId: string };
  await call(routes, 'POST /api/door/login/callback', { body: { response: 'r' }, query: { login: loginId } });
  const poll = (await call(routes, 'GET /api/door/login/poll', { query: { login: loginId } })) as { token: string };
  await assert.rejects(() => Promise.resolve(call(routes, 'POST /api/door/ask', { body: { token: poll.token, query: '   ' } })), /query is required/);
  assert.equal(spies.serveCalls.length, 0);
});
