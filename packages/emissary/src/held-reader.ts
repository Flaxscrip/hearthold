/**
 * A HELD READER — the Emissary self-driving a KB login as a read-only member, so it can answer over the
 * SHARED partition on someone else's behalf.
 *
 * The Warden demands a verified identity for every query ("identity proven, never asserted-by-absence"), so
 * an Emissary that wants to serve shared-corpus answers — to an anonymous visitor (the oracle) or to a
 * visitor it authenticated itself (the doorman) — holds ONE read-only member identity and logs IN as it: it
 * is both browser and wallet, driving `kb-login-start` then answering the challenge with its own keymaster.
 * The session is cached and re-established on expiry; a stale-session error triggers exactly one re-login.
 * Every query is pinned to `scope: 'shared'` and private citations are stripped — defence in depth so the
 * answer text can never draw on any private partition. This is the single secret such a server holds: a
 * read-only member on the KB, with no write or grant power.
 *
 * Extracted so the oracle module and the doorman skill share ONE implementation instead of two copies.
 */
import { PROTOCOL_VERSION, type Transport } from '@hearthold/core';

export interface HeldReaderDeps {
  transport: Pick<Transport, 'request'>;
  /** The KB Warden this reader logs into and queries. */
  wardenDid: string;
  /** The KB this reader is pinned to — every login and query targets it; a caller cannot redirect it. */
  kbId: string;
  /** Sign a Warden login challenge with the reader's OWN keymaster (the key never leaves). */
  createResponse(challenge: string, opts?: { registry?: string }): Promise<string>;
  /** The registry the reader's login response is anchored on — must match the Warden's. */
  registry: string;
  /** Callback baked into `kb-login-start` (cosmetic for a self-driven login; the reader answers itself). */
  callbackUrl: string;
  /** Per-request DIDComm timeout for the login legs (default 60s). */
  loginTimeoutMs?: number;
  /** Per-request DIDComm timeout for a query (default 200s — long enough to outlast a reasoning answer). */
  queryTimeoutMs?: number;
}

export interface HeldReader {
  /** A valid session token, logging in (or refreshing) as needed. Concurrent calls collapse into one login. */
  token(): Promise<string>;
  /** Answer a query over the SHARED partition only; re-logs-in once on a stale session; strips private citations. */
  serveShared(query: string, k?: number): Promise<{ answer: string; citations: unknown[] }>;
  /** Drop the cached session (forces a fresh login on the next call). */
  reset(): void;
}

export function makeHeldReader(deps: HeldReaderDeps): HeldReader {
  const loginTimeoutMs = deps.loginTimeoutMs ?? 60_000;
  const queryTimeoutMs = deps.queryTimeoutMs ?? 200_000;
  let session: { token: string; exp: number } | null = null;
  let inFlight: Promise<{ token: string; exp: number }> | null = null;

  async function login(): Promise<{ token: string; exp: number }> {
    // The reader is BOTH browser and wallet: drive login/start, then answer the challenge itself.
    const start = await deps.transport.request(
      deps.wardenDid,
      { type: 'hearthold/kb-login-start', version: PROTOCOL_VERSION, kbId: deps.kbId, callback: deps.callbackUrl },
      { timeoutMs: loginTimeoutMs },
    );
    if (start.type !== 'hearthold/kb-login-challenge') {
      throw new Error(`held-reader login: no challenge (${'reason' in start ? start.reason : start.type})`);
    }
    const response = await deps.createResponse(start.challenge, { registry: deps.registry });
    const sess = await deps.transport.request(
      deps.wardenDid,
      { type: 'hearthold/kb-login-complete', version: PROTOCOL_VERSION, kbId: deps.kbId, response },
      { timeoutMs: loginTimeoutMs },
    );
    if (sess.type !== 'hearthold/kb-session') {
      throw new Error(`held-reader login failed: ${'reason' in sess ? sess.reason : sess.type}`);
    }
    return { token: sess.token, exp: new Date(sess.expiresAt).getTime() };
  }

  async function token(): Promise<string> {
    if (session && session.exp - Date.now() > 30_000) return session.token;
    if (!inFlight) {
      inFlight = login()
        .then((s) => {
          session = s;
          return s;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return (await inFlight).token;
  }

  async function serveShared(query: string, k?: number): Promise<{ answer: string; citations: unknown[] }> {
    const ask = async () =>
      deps.transport.request(
        deps.wardenDid,
        // scope:'shared' pins recall to the SHARED partition only — the answer text can never draw on a private one.
        { type: 'hearthold/kb-session-request', version: PROTOCOL_VERSION, token: await token(), kbId: deps.kbId, action: 'query', query, k: k ?? 5, scope: 'shared' },
        { timeoutMs: queryTimeoutMs },
      );
    let reply = await ask();
    // A stale reader session surfaces as a kb-error — re-login ONCE and retry (never loop).
    if (reply.type === 'hearthold/kb-error' && /session|token|unauthor|expired|401/i.test(reply.reason)) {
      session = null;
      reply = await ask();
    }
    if (reply.type === 'hearthold/kb-error') throw new Error(reply.reason);
    if (reply.type !== 'hearthold/kb-result' || reply.action !== 'query') throw new Error('the reader could not answer that');
    // Defence in depth: a read-only reader has no private partition, but never surface a private citation.
    const citations = reply.citations.filter((c) => c.scope !== 'private');
    return { answer: reply.answer, citations };
  }

  return { token, serveShared, reset: () => { session = null; } };
}
