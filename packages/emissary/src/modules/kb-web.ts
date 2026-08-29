/**
 * The mages/`kb.archon.social` web faces, as composable Emissary skills.
 *
 * These are the two capabilities the public KB portal has always exposed — now on the module runtime, so a
 * deployment composes its web face from a loadout instead of a hard-wired server:
 *
 *   - `kb-relay`  — MEMBER login (challenge/response) + session ops, RELAYED to the Warden. The Warden
 *                   authenticates end-to-end (it issues + verifies the challenge, mints the session); this
 *                   relay holds no secret and gains no authority. Use when the Warden can resolve its members.
 *   - `oracle`    — ANONYMOUS (no-wallet) shared-corpus query, answered as a held read-only reader.
 *
 * Contrast `auth:web` (the doorman), where the EMISSARY authenticates the visitor itself — the pattern for a
 * SEALED Warden that can't resolve its members. All three compose on one runtime; a deployment picks the set.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { PROTOCOL_VERSION, type Transport, type KbSessionMessage } from '@hearthold/core';

import type { CapabilityModule } from '../module.js';
import type { HeldReader } from '../held-reader.js';

// ── kb-relay: member login + session ops, relayed to the Warden (the Warden authenticates) ──

export interface KbRelayDeps {
  transport: Pick<Transport, 'request'>;
  /** The KB Warden every login/session op is relayed to. */
  wardenDid: string;
  /** The Emissary's PUBLIC base URL — baked into the login callback the wallet POSTs to. */
  publicUrl: string;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface LoginAttempt {
  kbId: string;
  challenge: string;
  session?: KbSessionMessage;
  createdAt: number;
}

export function kbRelayModule(deps: KbRelayDeps): CapabilityModule {
  const now = deps.now ?? (() => Date.now());
  const logins = new Map<string, LoginAttempt>();
  const sweep = (): void => {
    const cutoff = now() - 10 * 60_000; // drop attempts older than 10 min (bound the map)
    for (const [id, a] of logins) if (a.createdAt < cutoff) logins.delete(id);
  };

  return {
    name: 'kb-relay',
    httpRoutes: {
      // Browser begins login → Warden issues a challenge bound to a callback carrying our loginId.
      'POST /api/kb/login/start': async ({ body }) => {
        sweep();
        const { kbId } = (body ?? {}) as { kbId?: string };
        if (!kbId) throw new Error('kbId is required');
        const loginId = randomBytes(12).toString('hex');
        const callback = `${deps.publicUrl}/api/kb/login/callback?login=${loginId}`;
        const reply = await deps.transport.request(
          deps.wardenDid,
          { type: 'hearthold/kb-login-start', version: PROTOCOL_VERSION, kbId, callback },
          { timeoutMs: 60_000 },
        );
        if (reply.type !== 'hearthold/kb-login-challenge') {
          const why = reply.type === 'hearthold/error' ? reply.reason : reply.type;
          throw new Error(`Warden did not issue a challenge: ${why}`);
        }
        logins.set(loginId, { kbId, challenge: reply.challenge, createdAt: now() });
        return { loginId, challenge: reply.challenge };
      },

      // The member's wallet POSTs its signed response here → Warden verifies + mints the session.
      'POST /api/kb/login/callback': async ({ body, query }) => {
        const loginId = query.get('login') ?? '';
        const { response } = (body ?? {}) as { response?: string };
        const attempt = logins.get(loginId);
        if (!attempt) throw new Error('unknown or expired login');
        if (!response) throw new Error('response is required');
        const reply = await deps.transport.request(
          deps.wardenDid,
          { type: 'hearthold/kb-login-complete', version: PROTOCOL_VERSION, kbId: attempt.kbId, response },
          { timeoutMs: 60_000 },
        );
        if (reply.type !== 'hearthold/kb-session') throw new Error(reply.type === 'hearthold/kb-error' ? reply.reason : 'login failed');
        attempt.session = reply;
        return { accepted: true };
      },

      // Browser polls until its wallet has responded and the Warden has minted a session.
      'GET /api/kb/login/poll': async ({ query }) => {
        const id = query.get('login') ?? '';
        const attempt = logins.get(id);
        if (!attempt) return { status: 'unknown' };
        if (!attempt.session) return { status: 'pending' };
        const session = attempt.session;
        logins.delete(id); // one-shot
        return { status: 'ready', session };
      },

      // Session-authenticated KB op — relayed verbatim; the Warden enforces authorization + assurance.
      'POST /api/kb/session-request': async ({ body }) => {
        const { token, kbId, action, query, k, kind, text, scope, docKey, owner } = (body ?? {}) as {
          token?: string;
          kbId?: string;
          action?: 'query' | 'update' | 'put-doc' | 'get-doc';
          query?: string;
          k?: number;
          kind?: string;
          text?: string;
          scope?: 'shared' | 'private';
          docKey?: string;
          owner?: string;
        };
        if (!token || !kbId || !action) throw new Error('token, kbId and action are required');
        const reply = await deps.transport.request(
          deps.wardenDid,
          { type: 'hearthold/kb-session-request', version: PROTOCOL_VERSION, token, kbId, action, query, k, kind, text, scope, docKey, owner },
          // Long enough to outlast a factor-2 step-up (the Warden may be awaiting the member's Signet).
          { timeoutMs: 200_000 },
        );
        return { result: reply };
      },
    },
  };
}

// ── oracle: anonymous (no-wallet) shared-corpus query, answered by a held read-only reader ──

export interface OracleModuleDeps {
  /** The held read-only reader that answers over the shared partition. */
  reader: HeldReader;
  /** The KB this oracle answers for — a caller cannot redirect it at another KB. */
  kbId: string;
  /** Per-IP requests per minute (default 8). */
  perIpPerMin?: number;
  /** Global cap on concurrent anonymous queries — protects the model host, the scarce resource (default 3). */
  maxConcurrent?: number;
  now?: () => number;
}

export function oracleModule(deps: OracleModuleDeps): CapabilityModule {
  const now = deps.now ?? (() => Date.now());
  const perIpPerMin = deps.perIpPerMin ?? 8;
  const maxConcurrent = deps.maxConcurrent ?? 3;
  let inFlight = 0;
  const ipHits = new Map<string, { count: number; windowStart: number }>();

  const ipAllowed = (ip: string): boolean => {
    const t = now();
    const rec = ipHits.get(ip);
    if (!rec || t - rec.windowStart >= 60_000) {
      ipHits.set(ip, { count: 1, windowStart: t });
      return true;
    }
    if (rec.count >= perIpPerMin) return false;
    rec.count += 1;
    return true;
  };
  const sweepIps = (): void => {
    const cutoff = now() - 60_000;
    for (const [ip, rec] of ipHits) if (rec.windowStart < cutoff) ipHits.delete(ip);
  };
  const clientIp = (req: IncomingMessage): string => {
    // Take the RIGHTMOST X-Forwarded-For hop — the one our own reverse proxy appended, NOT the leftmost
    // (which a client can freely spoof). The per-IP window is best-effort; the GLOBAL cap is the real guard.
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const hops = xff.split(',');
      return (hops[hops.length - 1] ?? xff).trim();
    }
    return req.socket?.remoteAddress ?? 'unknown';
  };

  return {
    name: 'oracle',
    httpRoutes: {
      'POST /api/kb/ask': async ({ body, req }) => {
        const { kbId, query, k } = (body ?? {}) as { kbId?: string; query?: string; k?: number };
        if (!query || query.trim().length === 0) throw new Error('query is required');
        // The oracle answers ONLY for its configured KB — a caller cannot redirect it.
        if ((kbId ?? deps.kbId) !== deps.kbId) throw new Error('this portal answers only for its configured KB');
        sweepIps();
        if (!ipAllowed(clientIp(req))) throw new Error('rate limit exceeded — please wait a moment and try again');
        if (inFlight >= maxConcurrent) throw new Error('the oracle is busy — please try again shortly');
        inFlight += 1;
        try {
          return await deps.reader.serveShared(query, k);
        } finally {
          inFlight -= 1;
        }
      },
    },
  };
}
