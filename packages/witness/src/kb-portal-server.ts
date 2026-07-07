/**
 * The public Mage's Knowledge Portal — HTTP → DIDComm bridge.
 *
 * The member's keys never touch the portal. Login is challenge/response (the archon.social pattern):
 * the browser gets a challenge from the Warden (via this Mage), the member's wallet/Signet responds
 * out-of-band, and the Warden mints a session. The browser then rides that session. This server only
 * relays — it authenticates and authorizes nothing (the Warden does, end-to-end). It holds no secret.
 *
 * A per-attempt `loginId` correlates three parties: the browser (polls for its session), the wallet
 * (POSTs its response to the callback), and the Warden (verifies + mints).
 */

import { randomBytes } from 'node:crypto';

import {
  startControlServer,
  PROTOCOL_VERSION,
  type ControlServer,
  type Transport,
  type KbSessionMessage,
} from '@hearthold/core';

export interface KbPortalOptions {
  transport: Transport;
  wardenDid: string;
  port: number;
  /** Bind host. Default loopback; set to 0.0.0.0 / a tailnet address to expose the portal publicly. */
  host?: string;
  /** The Mage's PUBLIC base URL — baked into the challenge callback the wallet POSTs to. */
  publicUrl: string;
}

interface LoginAttempt {
  challenge: string;
  session?: KbSessionMessage;
  createdAt: number;
}

export function startKbPortalServer(opts: KbPortalOptions): ControlServer {
  const { transport, wardenDid, publicUrl } = opts;
  const logins = new Map<string, LoginAttempt>();

  // Drop login attempts older than 10 min so the map can't grow unbounded.
  const sweep = (): void => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, a] of logins) if (a.createdAt < cutoff) logins.delete(id);
  };

  return startControlServer({
    port: opts.port,
    host: opts.host,
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
        logins.set(loginId, { challenge: reply.challenge, createdAt: Date.now() });
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
          { type: 'hearthold/kb-login-complete', version: PROTOCOL_VERSION, response },
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
        const { token, kbId, action, query, k, kind, text } = (body ?? {}) as {
          token?: string;
          kbId?: string;
          action?: 'query' | 'update';
          query?: string;
          k?: number;
          kind?: string;
          text?: string;
        };
        if (!token || !kbId || !action) throw new Error('token, kbId and action are required');
        const reply = await transport.request(
          wardenDid,
          { type: 'hearthold/kb-session-request', version: PROTOCOL_VERSION, token, kbId, action, query, k, kind, text },
          // Long enough to outlast a factor-2 step-up (the Warden may be awaiting the member's Signet).
          { timeoutMs: 200_000 },
        );
        return { result: reply };
      },
    },
    onListening: (p) =>
      process.stdout.write(
        `KB Portal (public Mage web face) on http://${opts.host ?? '127.0.0.1'}:${p}\n` +
          `  public URL:  ${publicUrl}\n  relaying to Warden: ${wardenDid.slice(0, 28)}…\n` +
          `  login: challenge/response (keys stay in the member's wallet/Signet); the Mage only carries\n`,
      ),
  });
}
