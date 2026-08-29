/**
 * Unit tests for the mages web faces after the runtime unification: the shared `makeHeldReader`, and the
 * `kb-relay` + `oracle` capability modules. All I/O (the DIDComm transport, the held reader) is stubbed, so
 * these run with no live node. They lock the behaviour the live mages portal depends on: the relay forwards
 * verbatim to the Warden and holds no authority; the oracle answers only its own KB, over shared scope, under
 * rate limits; the held reader logs in once, caches, and re-logs-in exactly once on a stale session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import { PROTOCOL_VERSION } from '@hearthold/core';

import { makeHeldReader } from '../src/held-reader.ts';
import { kbRelayModule, oracleModule } from '../src/modules/kb-web.ts';

type RouteMap = Record<string, (ctx: { body?: unknown; query: URLSearchParams; req: IncomingMessage }) => Promise<unknown> | unknown>;
const call = (routes: RouteMap, key: string, ctx: { body?: unknown; query?: Record<string, string>; req?: Partial<IncomingMessage> } = {}) => {
  const h = routes[key];
  if (!h) throw new Error(`no route ${key}`);
  return h({ body: ctx.body, query: new URLSearchParams(ctx.query ?? {}), req: (ctx.req ?? { headers: {}, socket: {} }) as IncomingMessage });
};

/** A transport stub that answers the three KB login/query messages; `onQuery` overrides the query reply. */
function stubTransport(onQuery?: () => unknown) {
  const calls: { type: string }[] = [];
  let logins = 0;
  const request = async (_did: string, msg: { type: string }): Promise<unknown> => {
    calls.push(msg);
    if (msg.type === 'hearthold/kb-login-start') {
      logins += 1;
      return { type: 'hearthold/kb-login-challenge', version: PROTOCOL_VERSION, challenge: `chal#${logins}` };
    }
    if (msg.type === 'hearthold/kb-login-complete') {
      return { type: 'hearthold/kb-session', version: PROTOCOL_VERSION, token: `tok#${logins}`, did: 'did:cid:reader', expiresAt: new Date(Date.now() + 1_000_000).toISOString() };
    }
    if (msg.type === 'hearthold/kb-session-request') {
      return (onQuery ?? (() => ({ type: 'hearthold/kb-result', version: PROTOCOL_VERSION, action: 'query', answer: 'A', citations: [{ scope: 'shared' }, { scope: 'private' }] })))();
    }
    throw new Error(`unexpected ${msg.type}`);
  };
  return { request, calls, get logins() { return logins; } };
}

// ── makeHeldReader ──

test('held reader: serveShared answers over shared scope and strips private citations', async () => {
  const tx = stubTransport();
  const reader = makeHeldReader({ transport: tx, wardenDid: 'w', kbId: 'k', createResponse: async () => 'resp', registry: 'local', callbackUrl: 'cb' });
  const out = await reader.serveShared('q', 3);
  assert.equal(out.answer, 'A');
  assert.deepEqual(out.citations, [{ scope: 'shared' }], 'a private citation is never surfaced');
  const qreq = tx.calls.find((c) => c.type === 'hearthold/kb-session-request') as { scope?: string; k?: number } | undefined;
  assert.equal(qreq?.scope, 'shared', 'the query is pinned to shared scope');
});

test('held reader: token caches — two serves share one login', async () => {
  const tx = stubTransport();
  const reader = makeHeldReader({ transport: tx, wardenDid: 'w', kbId: 'k', createResponse: async () => 'resp', registry: 'local', callbackUrl: 'cb' });
  await reader.serveShared('q1');
  await reader.serveShared('q2');
  assert.equal(tx.logins, 1, 'the cached session is reused; the reader does not log in per query');
});

test('held reader: a stale session triggers exactly one re-login, then succeeds', async () => {
  let n = 0;
  const tx = stubTransport(() => {
    n += 1;
    return n === 1
      ? { type: 'hearthold/kb-error', version: PROTOCOL_VERSION, reason: 'session expired — please log in again' }
      : { type: 'hearthold/kb-result', version: PROTOCOL_VERSION, action: 'query', answer: 'B', citations: [] };
  });
  const reader = makeHeldReader({ transport: tx, wardenDid: 'w', kbId: 'k', createResponse: async () => 'resp', registry: 'local', callbackUrl: 'cb' });
  const out = await reader.serveShared('q');
  assert.equal(out.answer, 'B');
  assert.equal(tx.logins, 2, 'stale → re-login once → retry succeeds');
});

// ── kb-relay module (member login, relayed to the Warden) ──

test('kb-relay: exposes the four member-login/session routes', () => {
  const mod = kbRelayModule({ transport: stubTransport(), wardenDid: 'w', publicUrl: 'https://mages.example' });
  assert.equal(mod.name, 'kb-relay');
  assert.deepEqual(Object.keys(mod.httpRoutes ?? {}).sort(), [
    'GET /api/kb/login/poll',
    'POST /api/kb/login/callback',
    'POST /api/kb/login/start',
    'POST /api/kb/session-request',
  ]);
});

test('kb-relay: login/start relays to the Warden and the callback carries the loginId', async () => {
  const tx = stubTransport();
  const routes = kbRelayModule({ transport: tx, wardenDid: 'w', publicUrl: 'https://mages.example' }).httpRoutes! as RouteMap;
  const out = (await call(routes, 'POST /api/kb/login/start', { body: { kbId: 'hearthold-kb' } })) as { loginId: string; challenge: string; pollSecret: string };
  assert.ok(out.loginId && out.challenge);
  assert.ok(out.pollSecret && out.pollSecret.length >= 32, 'start returns a poll secret');
  const start = tx.calls.find((c) => c.type === 'hearthold/kb-login-start') as { callback?: string; kbId?: string } | undefined;
  assert.equal(start?.kbId, 'hearthold-kb');
  assert.match(start?.callback ?? '', new RegExp(`login=${out.loginId}$`));
  // The poll secret must NOT be in the callback (which lands in the public challenge document).
  assert.ok(!(start?.callback ?? '').includes(out.pollSecret), 'the poll secret never enters the public callback URL');
});

test('kb-relay: full login → poll returns the Warden-minted session (relay gains no authority)', async () => {
  const tx = stubTransport();
  const routes = kbRelayModule({ transport: tx, wardenDid: 'w', publicUrl: 'https://mages.example' }).httpRoutes! as RouteMap;
  const { loginId, pollSecret } = (await call(routes, 'POST /api/kb/login/start', { body: { kbId: 'k' } })) as { loginId: string; pollSecret: string };
  const cb = (await call(routes, 'POST /api/kb/login/callback', { body: { response: 'signed' }, query: { login: loginId } })) as { accepted: boolean };
  assert.equal(cb.accepted, true);
  // Poll WITHOUT the secret — a party who only read the loginId off the gossip network — gets `unknown`, never
  // the session; and it is indistinguishable from an unknown id (no existence oracle).
  const stolen = (await call(routes, 'GET /api/kb/login/poll', { query: { login: loginId } })) as { status: string; session?: unknown };
  assert.equal(stolen.status, 'unknown', 'the loginId alone cannot claim the session');
  assert.equal(stolen.session, undefined);
  const wrong = (await call(routes, 'GET /api/kb/login/poll', { query: { login: loginId, secret: 'deadbeef'.repeat(8) } })) as { status: string };
  assert.equal(wrong.status, 'unknown', 'a wrong secret is refused, same as unknown');
  // Poll WITH the secret (the SPA that started the login) gets the session.
  const poll = (await call(routes, 'GET /api/kb/login/poll', { query: { login: loginId, secret: pollSecret } })) as { status: string; session?: { token: string } };
  assert.equal(poll.status, 'ready');
  assert.equal(poll.session?.token, 'tok#1', 'the session is the WARDEN’s, passed straight through');
});

test('kb-relay: login/start without a kbId is refused', async () => {
  const routes = kbRelayModule({ transport: stubTransport(), wardenDid: 'w', publicUrl: 'https://mages.example' }).httpRoutes! as RouteMap;
  await assert.rejects(() => Promise.resolve(call(routes, 'POST /api/kb/login/start', { body: {} })), /kbId is required/);
});

// ── oracle module (anonymous shared-corpus query) ──

const stubReader = (spy: { calls: number } = { calls: 0 }) => ({
  async token() { return 't'; },
  async serveShared(_q: string, _k?: number) { spy.calls += 1; return { answer: 'oracle-answer', citations: [] as unknown[] }; },
  reset() {},
});

test('oracle: answers its own KB over the held reader', async () => {
  const spy = { calls: 0 };
  const routes = oracleModule({ reader: stubReader(spy), kbId: 'agora' }).httpRoutes! as RouteMap;
  const out = (await call(routes, 'POST /api/kb/ask', { body: { kbId: 'agora', query: 'hi' } })) as { answer: string };
  assert.equal(out.answer, 'oracle-answer');
  assert.equal(spy.calls, 1);
});

test('oracle: refuses a redirect to a different KB, and an empty query', async () => {
  const routes = oracleModule({ reader: stubReader(), kbId: 'agora' }).httpRoutes! as RouteMap;
  await assert.rejects(() => Promise.resolve(call(routes, 'POST /api/kb/ask', { body: { kbId: 'other', query: 'hi' } })), /only for its configured KB/);
  await assert.rejects(() => Promise.resolve(call(routes, 'POST /api/kb/ask', { body: { query: '   ' } })), /query is required/);
});

test('oracle: per-IP rate limit fails closed after the budget', async () => {
  const routes = oracleModule({ reader: stubReader(), kbId: 'agora', perIpPerMin: 1 }).httpRoutes! as RouteMap;
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {} } as unknown as IncomingMessage;
  await call(routes, 'POST /api/kb/ask', { body: { query: 'a' }, req });
  await assert.rejects(() => Promise.resolve(call(routes, 'POST /api/kb/ask', { body: { query: 'b' }, req })), /rate limit exceeded/);
});
