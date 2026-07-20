import { randomBytes } from 'node:crypto';

interface Session {
  did: string;
  /** Absolute expiry (ms epoch) — set at issue, never slid on use (Fable addition 1). */
  exp: number;
}

/**
 * In-memory control-plane sessions (Phase 2). A member proves DID control at login (challenge/response,
 * reusing `keymaster.createChallenge`/`verifyResponse`); the Warden mints an opaque bearer token bound to
 * the proven DID, which the Table sends as `X-Hearthold-Session` on every request. The session DID — never
 * anything the client asserts — is what every route computes its visible set from (the G-grade boundary).
 *
 * Discipline: expiry is ABSOLUTE (never extended on use); tokens are never logged; `revoke`/`revokeAllFor`
 * return the dropped token(s) so the caller can zeroize any per-session partition keys bound to them
 * (guardianship-threat-model §4.3 — a removed member loses decryption ability immediately, not at TTL).
 */
export class ControlSessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly ttlMs: number) {}

  /** Mint a token for a proven DID. Absolute expiry from `ttlMs`. */
  issue(did: string): { token: string; expiresAt: string } {
    const token = randomBytes(24).toString('hex');
    const exp = Date.now() + this.ttlMs;
    this.sessions.set(token, { did, exp });
    return { token, expiresAt: new Date(exp).toISOString() };
  }

  /** The DID behind a token, or null if unknown/expired. Expired tokens are dropped on read. */
  resolve(token: string | undefined | null): string | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() > s.exp) {
      this.sessions.delete(token);
      return null;
    }
    return s.did;
  }

  /** Expiry (ISO) of a live token, for `whoami`. Null if unknown/expired. */
  expiresAt(token: string | undefined | null): string | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s || Date.now() > s.exp) return null;
    return new Date(s.exp).toISOString();
  }

  /** End one session (logout). Returns the dropped token (for session-key zeroization), or null. */
  revoke(token: string | undefined | null): string | null {
    if (!token || !this.sessions.has(token)) return null;
    this.sessions.delete(token);
    return token;
  }

  /** Drop ALL live sessions for a DID immediately (membership removal). Returns the revoked tokens. */
  revokeAllFor(did: string): string[] {
    const revoked: string[] = [];
    for (const [token, s] of this.sessions) {
      if (s.did === did) {
        this.sessions.delete(token);
        revoked.push(token);
      }
    }
    return revoked;
  }
}
