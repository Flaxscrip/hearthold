/**
 * The Emissary's Knowledge Portal — HTTP → DIDComm bridge.
 *
 * The member's keys never touch the portal. Login is challenge/response (the archon.social pattern):
 * the browser gets a challenge from the Warden (via this Emissary), the member's wallet/Signet responds
 * out-of-band, and the Warden mints a session. The browser then rides that session. This server only
 * relays — it authenticates and authorizes nothing (the Warden does, end-to-end). It holds no secret.
 *
 * A per-attempt `loginId` correlates three parties: the browser (polls for its session), the wallet
 * (POSTs its response to the callback), and the Warden (verifies + mints).
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  startControlServer,
  PROTOCOL_VERSION,
  type ControlServer,
  type Transport,
  type KbSessionMessage,
} from '@hearthold/core';

/**
 * The read-only ORACLE reader that powers anonymous (no-wallet) queries. The Warden requires a verified
 * identity for every query — "identity proven, never asserted-by-absence" — so to serve a public
 * "ask the chronicle" box the portal holds ONE read-only member and answers anonymous visitors AS it,
 * pinned to `kbId` and (by that member's read authority) the shared chronicle. This is the single secret
 * this otherwise relay-only server holds: a read-only member on a PUBLIC KB, with no write or grant power.
 */
export interface OracleReader {
  /** Sign a Warden login challenge with the reader's keymaster — the portal self-drives the reader's login. */
  createResponse(challenge: string, opts?: { registry?: string }): Promise<string>;
  /** The KB this oracle answers for. Every anonymous ask is pinned to it; a caller cannot redirect it. */
  kbId: string;
  /** Registry for the reader's login response — must match the Warden's. */
  registry: string;
  /** Per-IP requests per minute for the anonymous route (default 8). */
  perIpPerMin?: number;
  /** Global cap on concurrent anonymous queries — protects the model host, the scarce resource (default 3). */
  maxConcurrent?: number;
}

export interface KbPortalOptions {
  transport: Transport;
  wardenDid: string;
  port: number;
  /** Bind host. Default loopback; set to 0.0.0.0 / a tailnet address to expose the portal publicly. */
  host?: string;
  /** The Emissary's PUBLIC base URL — baked into the challenge callback the wallet POSTs to. */
  publicUrl: string;
  /** Supply a read-only oracle reader to enable the anonymous (no-wallet) `POST /api/kb/ask` route. */
  oracle?: OracleReader;
}

interface LoginAttempt {
  kbId: string;
  challenge: string;
  session?: KbSessionMessage;
  createdAt: number;
}

export function startKbPortalServer(opts: KbPortalOptions): ControlServer {
  const { transport, wardenDid, publicUrl } = opts;
  // The Emissary is request-only (it relays to the Warden). Keep its mailbox reader continuously alive so
  // it never goes idle between logins — an idle reader lets the relay session go stale and later
  // replies silently vanish (symptom: works for a while, then `transport: timeout` until restart).
  transport.keepAlive?.();
  const logins = new Map<string, LoginAttempt>();

  // Drop login attempts older than 10 min so the map can't grow unbounded.
  const sweep = (): void => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, a] of logins) if (a.createdAt < cutoff) logins.delete(id);
  };

  // ── Anonymous oracle: a held read-only reader session + rate guards ──
  const oracle = opts.oracle;
  // The reader's session, refreshed on expiry. Concurrent refreshes collapse into one in-flight login.
  let readerSession: KbSessionMessage | null = null;
  let readerLoginInFlight: Promise<KbSessionMessage> | null = null;
  async function loginReader(reader: OracleReader): Promise<KbSessionMessage> {
    // The portal is BOTH browser and wallet here: it drives login/start then answers the challenge itself.
    const start = await transport.request(
      wardenDid,
      { type: 'hearthold/kb-login-start', version: PROTOCOL_VERSION, kbId: reader.kbId, callback: `${publicUrl}/api/kb/ask` },
      { timeoutMs: 60_000 },
    );
    if (start.type !== 'hearthold/kb-login-challenge') {
      throw new Error(`oracle login: Warden issued no challenge (${'reason' in start ? start.reason : start.type})`);
    }
    const response = await reader.createResponse(start.challenge, { registry: reader.registry });
    const sess = await transport.request(
      wardenDid,
      { type: 'hearthold/kb-login-complete', version: PROTOCOL_VERSION, kbId: reader.kbId, response },
      { timeoutMs: 60_000 },
    );
    if (sess.type !== 'hearthold/kb-session') {
      throw new Error(`oracle login failed: ${'reason' in sess ? sess.reason : sess.type}`);
    }
    return sess;
  }
  async function readerToken(reader: OracleReader): Promise<string> {
    if (readerSession && new Date(readerSession.expiresAt).getTime() - Date.now() > 30_000) return readerSession.token;
    if (!readerLoginInFlight) {
      readerLoginInFlight = loginReader(reader)
        .then((s) => {
          readerSession = s;
          return s;
        })
        .finally(() => {
          readerLoginInFlight = null;
        });
    }
    return (await readerLoginInFlight).token;
  }

  // Two guards on the anonymous route: a per-IP window (abuse) and a GLOBAL in-flight cap (the model host
  // behind recall is the scarce resource — cap concurrency regardless of source). Both fail closed.
  const perIpPerMin = oracle?.perIpPerMin ?? 8;
  const maxConcurrent = oracle?.maxConcurrent ?? 3;
  let inFlight = 0;
  const ipHits = new Map<string, { count: number; windowStart: number }>();
  const ipAllowed = (ip: string): boolean => {
    const now = Date.now();
    const rec = ipHits.get(ip);
    if (!rec || now - rec.windowStart >= 60_000) {
      ipHits.set(ip, { count: 1, windowStart: now });
      return true;
    }
    if (rec.count >= perIpPerMin) return false;
    rec.count += 1;
    return true;
  };
  const sweepIps = (): void => {
    const cutoff = Date.now() - 60_000;
    for (const [ip, rec] of ipHits) if (rec.windowStart < cutoff) ipHits.delete(ip);
  };
  const clientIp = (req: IncomingMessage): string => {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) return (xff.split(',')[0] ?? xff).trim();
    return req.socket?.remoteAddress ?? 'unknown';
  };

  // The KB portal is a DELIBERATELY-public Mage (fronted by nginx at `publicUrl`), so it must allow its own
  // public origin/host — but still not `*`. Requests from its own UI (Origin/Host = publicUrl) and non-browser
  // callers (no Origin) are allowed; other browser origins are refused. Add more via a deployment override if
  // a third-party browser client ever needs it.
  const portalOrigins = (() => {
    try {
      return [new URL(publicUrl).origin];
    } catch {
      return [];
    }
  })();

  return startControlServer({
    port: opts.port,
    host: opts.host,
    allowOrigins: portalOrigins,
    routes: {
      // ── Login (challenge/response) ──
      // Browser begins login → Warden issues a challenge bound to a callback carrying our loginId.
      'POST /api/kb/login/start': async ({ body }) => {
        sweep();
        const { kbId } = (body ?? {}) as { kbId?: string };
        if (!kbId) throw new Error('kbId is required');
        const loginId = randomBytes(12).toString('hex');
        const callback = `${publicUrl}/api/kb/login/callback?login=${loginId}`;
        process.stdout.write(`[kb-web] login/start → relaying to Warden ${wardenDid.slice(0, 20)}…\n`);
        const reply = await transport.request(
          wardenDid,
          { type: 'hearthold/kb-login-start', version: PROTOCOL_VERSION, kbId, callback },
          { timeoutMs: 60_000 },
        );
        if (reply.type !== 'hearthold/kb-login-challenge') {
          const why = reply.type === 'hearthold/error' ? reply.reason : reply.type;
          process.stdout.write(`[kb-web] login/start ✗ ${why}\n`);
          throw new Error(`Warden did not issue a challenge: ${why}`);
        }
        process.stdout.write(`[kb-web] login/start ✓ challenge received\n`);
        logins.set(loginId, { kbId, challenge: reply.challenge, createdAt: Date.now() });
        return { loginId, challenge: reply.challenge };
      },

      // The member's wallet POSTs its signed response here → Warden verifies + mints the session.
      'POST /api/kb/login/callback': async ({ body, query }) => {
        const loginId = query.get('login') ?? '';
        const { response } = (body ?? {}) as { response?: string };
        const attempt = logins.get(loginId);
        if (!attempt) throw new Error('unknown or expired login');
        if (!response) throw new Error('response is required');
        const reply = await transport.request(
          wardenDid,
          { type: 'hearthold/kb-login-complete', version: PROTOCOL_VERSION, kbId: attempt.kbId, response },
          { timeoutMs: 60_000 },
        );
        if (reply.type !== 'hearthold/kb-session') throw new Error(reply.type === 'hearthold/kb-error' ? reply.reason : 'login failed');
        attempt.session = reply;
        return { accepted: true };
      },

      // Browser polls until its wallet has responded and the Warden has minted a session.
      'GET /api/kb/login/poll': async ({ query }) => {
        const attempt = logins.get(query.get('login') ?? '');
        if (!attempt) return { status: 'unknown' };
        if (!attempt.session) return { status: 'pending' };
        const session = attempt.session;
        logins.delete(query.get('login') ?? ''); // one-shot
        return { status: 'ready', session };
      },

      // ── Session-authenticated KB ops ──
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
        const reply = await transport.request(
          wardenDid,
          { type: 'hearthold/kb-session-request', version: PROTOCOL_VERSION, token, kbId, action, query, k, kind, text, scope, docKey, owner },
          // Long enough to outlast a factor-2 step-up (the Warden may be awaiting the member's Signet).
          { timeoutMs: 200_000 },
        );
        return { result: reply };
      },

      // ── Anonymous public query (no wallet) ──
      // A visitor asks the chronicle with no login. The portal answers AS its read-only oracle reader,
      // pinned to the reader's KB and (by that member's read authority) the shared chronicle. Rate-limited
      // per IP and globally. Absent an oracle reader, the route reports it is disabled — never open by default.
      'POST /api/kb/ask': async ({ body, req }) => {
        if (!oracle) throw new Error('anonymous query is not enabled on this portal');
        const { kbId, query, k } = (body ?? {}) as { kbId?: string; query?: string; k?: number };
        if (!query || query.trim().length === 0) throw new Error('query is required');
        // The oracle answers ONLY for its configured KB — a caller cannot redirect it at another KB.
        if ((kbId ?? oracle.kbId) !== oracle.kbId) throw new Error('this portal answers only for its configured KB');
        sweepIps();
        if (!ipAllowed(clientIp(req))) throw new Error('rate limit exceeded — please wait a moment and try again');
        if (inFlight >= maxConcurrent) throw new Error('the oracle is busy — please try again shortly');
        inFlight += 1;
        try {
          let token = await readerToken(oracle);
          const ask = () =>
            transport.request(
              wardenDid,
              { type: 'hearthold/kb-session-request', version: PROTOCOL_VERSION, token, kbId: oracle.kbId, action: 'query', query, k: k ?? 5 },
              { timeoutMs: 200_000 },
            );
          let reply = await ask();
          // A stale reader session surfaces as a kb-error — re-login ONCE and retry (never loop).
          if (reply.type === 'hearthold/kb-error' && /session|token|unauthor|expired|401/i.test(reply.reason)) {
            readerSession = null;
            token = await readerToken(oracle);
            reply = await ask();
          }
          if (reply.type === 'hearthold/kb-error') throw new Error(reply.reason);
          if (reply.type !== 'hearthold/kb-result' || reply.action !== 'query') throw new Error('the oracle could not answer that');
          // Defence in depth: the read-only reader has no private partition, but never surface a private citation.
          const citations = reply.citations.filter((c) => c.scope !== 'private');
          return { answer: reply.answer, citations };
        } finally {
          inFlight -= 1;
        }
      },
    },
    onListening: (p) =>
      process.stdout.write(
        `KB Portal (Emissary web face) on http://${opts.host ?? '127.0.0.1'}:${p}\n` +
          `  public URL:  ${publicUrl}\n  relaying to Warden: ${wardenDid.slice(0, 28)}…\n` +
          `  login: challenge/response (keys stay in the member's wallet/Signet); the Emissary only carries\n`,
      ),
  });
}
