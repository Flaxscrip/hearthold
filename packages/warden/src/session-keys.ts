import type { CipherPrivateJwk } from '@hearthold/core';

/**
 * The read-guest keys: per-session, transient partition private keys the Warden holds ONLY while a member
 * is logged in, so it can RAG that member's own private content (guardianship-threat-model §4a). Keyed by
 * session token → partitionId. **In memory only — never persisted.** Zeroized the instant a session ends
 * (logout / expiry / membership removal, §4.3), so a removed member loses decryption immediately, not at TTL.
 */
export class SessionKeyStore {
  private readonly keys = new Map<string, Map<string, CipherPrivateJwk>>();

  put(token: string, partitionId: string, priv: CipherPrivateJwk): void {
    let m = this.keys.get(token);
    if (!m) {
      m = new Map();
      this.keys.set(token, m);
    }
    m.set(partitionId, priv);
  }

  /** The transient key for a partition in this session, or undefined (rewrap not done / zeroized). */
  get(token: string, partitionId: string): CipherPrivateJwk | undefined {
    return this.keys.get(token)?.get(partitionId);
  }

  /** Whether the Warden can transiently read this partition for this session. */
  has(token: string, partitionId: string): boolean {
    return this.keys.get(token)?.has(partitionId) ?? false;
  }

  /** Number of partitions unlocked for a session (for whoami/telemetry). */
  count(token: string): number {
    return this.keys.get(token)?.size ?? 0;
  }

  /**
   * Drop ALL keys for a session — logout / expiry / removal. Best-effort scrub of the in-memory JWK fields
   * before dropping the references, so the key material doesn't linger in a live map. Returns the count.
   */
  zeroize(token: string): number {
    const m = this.keys.get(token);
    if (!m) return 0;
    const n = m.size;
    for (const priv of m.values()) {
      if (priv && typeof priv === 'object') {
        const rec = priv as unknown as Record<string, unknown>;
        for (const k of Object.keys(rec)) rec[k] = '';
      }
    }
    m.clear();
    this.keys.delete(token);
    return n;
  }
}
