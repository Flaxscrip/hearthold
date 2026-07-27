import type { CipherPrivateJwk } from '@hearthold/core';

/**
 * A held read-guest key. The secret component of an EC/OKP private JWK is the `d` scalar (base64url); the
 * other fields (`kty`/`crv`/`x`/`y`) are PUBLIC. We keep `d` as raw bytes in a `Buffer` so `zeroize` can
 * overwrite it IN PLACE — a JS string can't be wiped (immutable; lingers until GC), a Buffer can. The
 * public fields are held as a plain object; the JWK is reassembled only transiently for a single decrypt.
 */
interface HeldKey {
  pub: Record<string, unknown>;
  d: Buffer;
}

/**
 * The read-guest keys: per-session, transient partition private keys the Warden holds ONLY while a member
 * is logged in, so it can RAG that member's own private content (guardianship-threat-model §4a). Keyed by
 * session token → partitionId. **In memory only — never persisted.** Zeroized the instant a session ends
 * (logout / expiry / membership removal, §4.3), so a removed member loses decryption immediately, not at TTL.
 */
export class SessionKeyStore {
  private readonly keys = new Map<string, Map<string, HeldKey>>();

  put(token: string, partitionId: string, priv: CipherPrivateJwk): void {
    // Copy the secret `d` into a Buffer and hold only that + the public fields; the caller's original JWK
    // string is no longer referenced by us (GC-eligible), and the copy we keep is wipeable.
    const { d, ...pub } = priv as unknown as Record<string, unknown> & { d?: string };
    const held: HeldKey = { pub, d: Buffer.from(typeof d === 'string' ? d : '', 'utf8') };
    let m = this.keys.get(token);
    if (!m) {
      m = new Map();
      this.keys.set(token, m);
    }
    // Wipe a prior key at this slot before replacing it (don't orphan an un-scrubbed Buffer).
    m.get(partitionId)?.d.fill(0);
    m.set(partitionId, held);
  }

  /** The transient key for a partition in this session, or undefined (rewrap not done / zeroized). */
  get(token: string, partitionId: string): CipherPrivateJwk | undefined {
    const held = this.keys.get(token)?.get(partitionId);
    if (!held) return undefined;
    // Reassemble the JWK for ONE decrypt. The `d` string this materializes is short-lived (GC'd after the
    // crypto call); the SESSION-resident secret stays Buffer-backed and wipeable — that's the point.
    return { ...held.pub, d: held.d.toString('utf8') } as unknown as CipherPrivateJwk;
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
   * Drop ALL keys for a session — logout / expiry / removal. A REAL wipe: each secret `d` is held in a
   * Buffer, so `fill(0)` overwrites the key bytes in place before the references are dropped. Returns the
   * count. The decryption capability via this store dies synchronously here, not at TTL.
   *
   * Residual (documented, not a guarantee): a JWK string a caller already materialized via `get()` for a
   * decrypt, and any private copy the crypto library made, live until GC — the ceiling for in-memory
   * secrets in a GC'd runtime. What changed vs. the old string-scrub (Fable review 2026-07-16): the
   * SESSION-resident copy — the one that lingered longest — is now genuinely overwritten, not merely
   * de-referenced with an immutable-string field that survived until collection.
   */
  zeroize(token: string): number {
    const m = this.keys.get(token);
    if (!m) return 0;
    const n = m.size;
    for (const held of m.values()) held.d.fill(0); // overwrite the secret bytes in place
    m.clear();
    this.keys.delete(token);
    return n;
  }
}
