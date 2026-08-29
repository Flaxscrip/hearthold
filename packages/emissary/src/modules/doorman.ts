/**
 * The Doorman — the Emissary's public web-authenticator skill (`auth:web`).
 *
 * This is the answer to the public/private tension: a Warden bound to a SEALED node can put an external
 * member on the guest list (authorize) but can't check their ID at the door (authenticate) — the member's
 * identity lives on a registry the sealed node has no peer for. The doorman moves the door to where it
 * belongs: the world-facing Emissary. It runs challenge/response with the visitor using the EMISSARY's OWN
 * keymaster (the Emissary is public — it can resolve the visitor, and holds no vault to lose), then asks the
 * sealed Warden the one question the Warden CAN answer without resolving anyone: is this now-authenticated
 * DID an authorized member? (a pure `testGroup` on the DID string). Authentication at the Emissary,
 * AUTHORIZATION at the Warden — the two halves that a sealed custodian could never do alone.
 *
 * Serving is pinned to the SHARED corpus (`serveShared`): the doorman answers from its own shared-scope read
 * session, never any member's private partition. So a compromised doorman leaks at most this one KB's gated
 * shared corpus — never the vault, never write, never a private partition, never another KB — and the
 * Sovereign revokes the doorman's read authority to shut it. See `docs/doorman.md`.
 *
 * Pure in the module: authentication, membership, and serving are all INJECTED (`DoormanDeps`) — the module
 * owns only the login/session state machine, so it is unit-testable with stubs. The live wiring (Emissary
 * keymaster, Warden transport) lives in the entrypoint that mounts this on the runtime.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { CapabilityModule } from '../module.js';

export interface DoormanDeps {
  /** The KB this doorman guards. Every login and every query is pinned to it — a caller cannot redirect it. */
  kbId: string;
  /** The Emissary's PUBLIC base URL — baked into the challenge callback the visitor's wallet POSTs back to. */
  publicUrl: string;
  /** Mint an Archon authentication challenge with the EMISSARY's OWN keymaster (NOT the Warden's). */
  createChallenge(input: { callback: string; kbId: string }): Promise<string>;
  /** Verify a visitor's signed response with the EMISSARY's OWN keymaster → the authenticated responder DID. */
  verifyResponse(responseDID: string): Promise<{ match: boolean; responder?: string }>;
  /** Ask the Warden whether an authenticated DID is an authorized member (pure membership test, no resolution). */
  authorizeSubject(subjectDid: string): Promise<boolean>;
  /** Answer a query from the doorman's OWN shared-scope read session — never a private partition. */
  serveShared(query: string, k?: number): Promise<{ answer: string; citations: unknown[] }>;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Doorman session lifetime (default 30 min). */
  sessionTtlMs?: number;
  /** How long an in-flight login attempt is retained before it's swept (default 10 min). */
  loginTtlMs?: number;
}

interface Attempt {
  challenge: string;
  createdAt: number;
  /** Secret returned to the SPA at `start`, required by `poll`. Never placed in the callback URL, so it never
   *  enters the PUBLIC challenge document — the loginId alone (which does travel there) can't claim the session. */
  pollSecret: string;
  session?: { token: string; subjectDid: string; expiresAt: number };
  /** Set when authentication or authorization failed, so the browser's poll learns the outcome. */
  denied?: string;
}

/** Constant-time secret compare that tolerates unequal lengths (timingSafeEqual throws on a length mismatch). */
function secretEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function doormanModule(deps: DoormanDeps): CapabilityModule {
  const now = deps.now ?? (() => Date.now());
  const sessionTtlMs = deps.sessionTtlMs ?? 30 * 60_000;
  const loginTtlMs = deps.loginTtlMs ?? 10 * 60_000;
  const logins = new Map<string, Attempt>(); // loginId → attempt (correlates browser + wallet + verdict)
  const sessions = new Map<string, { subjectDid: string; exp: number }>(); // token → doorman session

  // Bound both maps so neither grows without limit.
  const sweep = (): void => {
    const loginCut = now() - loginTtlMs;
    for (const [id, a] of logins) if (a.createdAt < loginCut) logins.delete(id);
    const t = now();
    for (const [tok, s] of sessions) if (t > s.exp) sessions.delete(tok);
  };

  return {
    name: 'auth:web',
    httpRoutes: {
      // ── Login (challenge/response), run by the EMISSARY's own keymaster ──
      // The visitor begins login → the doorman mints a challenge itself (the Warden is never in this loop).
      'POST /api/door/login/start': async () => {
        sweep();
        const loginId = randomBytes(12).toString('hex');
        // Poll secret → SPA only, never in the callback URL (which lands in the public challenge document).
        const pollSecret = randomBytes(32).toString('hex');
        const callback = `${deps.publicUrl}/api/door/login/callback?login=${loginId}`;
        const challenge = await deps.createChallenge({ callback, kbId: deps.kbId });
        logins.set(loginId, { challenge, pollSecret, createdAt: now() });
        return { loginId, challenge, pollSecret, kbId: deps.kbId };
      },

      // The visitor's wallet POSTs its signed response → AUTHENTICATE (Emissary) then AUTHORIZE (Warden).
      'POST /api/door/login/callback': async ({ body, query }) => {
        const loginId = query.get('login') ?? '';
        const { response } = (body ?? {}) as { response?: string };
        const attempt = logins.get(loginId);
        if (!attempt) throw new Error('unknown or expired login');
        if (!response) throw new Error('response is required');

        // 1. AUTHENTICATE — the Emissary's own keymaster proves the visitor controls their DID.
        const verified = await deps
          .verifyResponse(response)
          .catch(() => ({ match: false }) as { match: boolean; responder?: string });
        if (!verified.match || !verified.responder) {
          attempt.denied = 'login response did not verify';
          return { accepted: false, reason: attempt.denied };
        }

        // 2. AUTHORIZE — the sealed Warden confirms membership (pure testGroup on the DID string).
        const authorized = await deps.authorizeSubject(verified.responder).catch(() => false);
        if (!authorized) {
          attempt.denied = 'not an authorized member of this KB';
          return { accepted: false, reason: attempt.denied };
        }

        // 3. Mint a doorman session bound to the authenticated + authorized subject.
        const token = randomBytes(24).toString('hex');
        const exp = now() + sessionTtlMs;
        sessions.set(token, { subjectDid: verified.responder, exp });
        attempt.session = { token, subjectDid: verified.responder, expiresAt: exp };
        return { accepted: true };
      },

      // The browser polls until its wallet has responded and the doorman has ruled. Requires the poll secret
      // from `start` — the loginId alone (public, in the challenge doc) must not be enough to claim the
      // session/verdict. A missing/wrong secret returns the SAME `unknown` so poll can't probe loginIds.
      'GET /api/door/login/poll': async ({ query }) => {
        const id = query.get('login') ?? '';
        const secret = query.get('secret') ?? '';
        const attempt = logins.get(id);
        if (!attempt || !secretEq(secret, attempt.pollSecret)) return { status: 'unknown' };
        if (attempt.denied) {
          logins.delete(id); // one-shot
          return { status: 'denied', reason: attempt.denied };
        }
        if (!attempt.session) return { status: 'pending' };
        const session = attempt.session;
        logins.delete(id); // one-shot
        return { status: 'ready', token: session.token, expiresAt: new Date(session.expiresAt).toISOString() };
      },

      // ── Session-authenticated query — SHARED corpus only ──
      'POST /api/door/ask': async ({ body }) => {
        const { token, query, k } = (body ?? {}) as { token?: string; query?: string; k?: number };
        if (!token) throw new Error('token is required');
        if (!query || query.trim().length === 0) throw new Error('query is required');
        const s = sessions.get(token);
        if (!s) throw new Error('unknown session — please log in');
        if (now() > s.exp) {
          sessions.delete(token);
          throw new Error('session expired — please log in again');
        }
        const { answer, citations } = await deps.serveShared(query, k);
        return { answer, citations };
      },
    },
  };
}
