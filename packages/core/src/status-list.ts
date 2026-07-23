/**
 * W3C Bitstring Status List for mesh recognition revocation — replaces the recognitionId list.
 *
 * The old list held opaque recognitionIds, so its LENGTH was exactly the revocation count: activity volume
 * leaked even though the contents didn't. This is the standards-aligned fix — a fixed-size bitstring where
 * each recognition carries a random index; a set bit means revoked. The W3C **Bitstring Status List**
 * (verifiable-credentials Bitstring Status List) is the reference; we adopt its shape as we adopted RFC
 * 9901's for salted-hash disclosure. A verifier fetches the WHOLE list, so no per-credential query reveals
 * which recognition is being checked (herd privacy).
 *
 * Herd privacy REDUCES but does not ELIMINATE volume leakage: a GZIP'd bitstring with many set bits
 * compresses worse than a sparse one, so compressed size still correlates loosely with the revocation
 * count. Better than a UUID list whose length IS the count — not zero. See FINDINGS.md.
 *
 * Archon stays dumb: it stores, versions, and controller-checks an opaque signed blob (the encoded
 * bitstring) — it never understands "revocation." Same asset + controller + version-pinning discipline as
 * everything else (record BOTH versionSequence and the content-addressed versionId; assert they match on
 * resolve). Fail-CLOSED wherever the status fact is unavailable.
 */

import { gzipSync, gunzipSync } from 'node:zlib';

import type { KeymasterHandle } from './keymaster.js';
import type { HearthholdConfig } from './config.js';
import { lookupIndex } from './allocation.js';

/** W3C minimum length. The minimum EXISTS to provide herd privacy — do not shrink it. */
export const STATUS_LIST_LENGTH = 131_072;
export const STATUS_LIST_BYTES = STATUS_LIST_LENGTH / 8; // 16384

// ── Bitstring ────────────────────────────────────────────────────────────────────────────────────────

/** GZIP-compress then base64 — the W3C `encodedList` form. */
export function encodeBitstring(bytes: Uint8Array): string {
  return gzipSync(Buffer.from(bytes)).toString('base64');
}

/** base64 then GUNZIP. Rejects anything that does not decode to exactly the fixed length. */
export function decodeBitstring(encoded: string): Uint8Array {
  const bytes = new Uint8Array(gunzipSync(Buffer.from(encoded, 'base64')));
  if (bytes.length !== STATUS_LIST_BYTES) throw new Error(`status list is ${bytes.length} bytes, expected ${STATUS_LIST_BYTES}`);
  return bytes;
}

/** W3C bit order: index 0 is the most-significant bit of the first byte. */
export function getBit(bytes: Uint8Array, index: number): boolean {
  if (index < 0 || index >= STATUS_LIST_LENGTH) throw new Error(`status index ${index} out of range`);
  return ((bytes[index >>> 3]! >>> (7 - (index & 7))) & 1) === 1;
}
function setBit(bytes: Uint8Array, index: number): void {
  bytes[index >>> 3]! |= 0x80 >>> (index & 7);
}

// Indices are allocated durably + collision-free via the sealed AllocationRecord — see allocation.ts.

// ── Schemas ──────────────────────────────────────────────────────────────────────────────────────────

export interface StatusListBody {
  issuer: string;
  statusPurpose: 'revocation';
  /** GZIP+base64 of the fixed-length bitstring. */
  encodedList: string;
  listVersion: number;
  updatedAt: string;
}

export interface SignedStatusList extends StatusListBody {
  proof?: { verificationMethod: string; proofValue: string; created: string; [k: string]: unknown };
}

/** A version-pinned reference — BOTH keys, asserted to match on resolve. */
export interface StatusListPin {
  statusListCredential: string;
  versionSequence: number;
  versionId: string;
  checkedAt: string;
}

const pinOf = (statusListCredential: string, doc: { didDocumentMetadata?: unknown }): StatusListPin => {
  const m = (doc.didDocumentMetadata ?? {}) as { versionId?: string; versionSequence?: string };
  return { statusListCredential, versionSequence: Number(m.versionSequence ?? 0), versionId: m.versionId ?? '', checkedAt: new Date().toISOString() };
};

// ── Issuer side ──────────────────────────────────────────────────────────────────────────────────────

/** Create an empty, signed StatusList owned by the issuing Sovereign. Returns its DID + initial pin. */
export async function createStatusList(
  issuer: KeymasterHandle,
  issuerName: string,
  config: HearthholdConfig,
): Promise<{ statusListCredential: string; pin: StatusListPin }> {
  const km = issuer.keymaster;
  await km.setCurrentId(issuerName);
  const issuerDid = (await km.resolveDID(issuerName)).didDocument?.id ?? '';
  const body: StatusListBody = { issuer: issuerDid, statusPurpose: 'revocation', encodedList: encodeBitstring(new Uint8Array(STATUS_LIST_BYTES)), listVersion: 1, updatedAt: new Date().toISOString() };
  const signed = await km.addProof(body, issuerName);
  const statusListCredential = await km.createAsset(signed, { registry: config.registry });
  return { statusListCredential, pin: pinOf(statusListCredential, await km.resolveDID(statusListCredential)) };
}

/**
 * Revoke `recognitionId` — resolve its index through the sealed AllocationRecord, set that bit, and update
 * the asset. The caller does NOT track indices. Idempotent: setting an already-set bit mints no new version.
 * Returns the pin (+ the resolved index) of the resulting (or existing) list version.
 */
export async function publishRevocation(
  issuer: KeymasterHandle,
  issuerName: string,
  statusListCredential: string,
  recognitionId: string,
  allocationRecord: string,
  config: HearthholdConfig,
): Promise<{ pin: StatusListPin; listVersion: number; alreadyRevoked: boolean; statusListIndex: number }> {
  const km = issuer.keymaster;
  const statusListIndex = await lookupIndex(issuer, issuerName, allocationRecord, recognitionId);
  if (statusListIndex === null) throw new Error(`recognition ${recognitionId} has no allocated index in the record`);
  await km.setCurrentId(issuerName);
  const issuerDid = (await km.resolveDID(issuerName)).didDocument?.id ?? '';
  const doc = await km.resolveDID(statusListCredential);
  const cur = (doc.didDocumentData ?? {}) as SignedStatusList;
  const bytes = decodeBitstring(cur.encodedList);

  if (getBit(bytes, statusListIndex)) {
    return { pin: pinOf(statusListCredential, doc), listVersion: cur.listVersion ?? 0, alreadyRevoked: true, statusListIndex };
  }
  setBit(bytes, statusListIndex);
  const listVersion = (cur.listVersion ?? 0) + 1;
  const body: StatusListBody = { issuer: issuerDid, statusPurpose: 'revocation', encodedList: encodeBitstring(bytes), listVersion, updatedAt: new Date().toISOString() };
  const signed = (await km.addProof(body, issuerName)) as unknown as Record<string, unknown>;
  await km.mergeData(statusListCredential, signed); // controller-signed update → new version
  return { pin: pinOf(statusListCredential, await km.resolveDID(statusListCredential)), listVersion, alreadyRevoked: false, statusListIndex };
}

// ── Checker side (resolver with max-age cache + fail-closed + version pin) ──────────────────────────────

export interface StatusCheck {
  /** FALSE ⇒ the fact is unavailable and the caller MUST fail closed (deny). */
  available: boolean;
  revoked: boolean;
  pin?: StatusListPin;
  reason?: string;
}

/**
 * Resolves the issuer's StatusList with a max-age cache and FAIL-CLOSED semantics. On a cache miss it
 * re-resolves, verifies the Sovereign's signature, and decodes + pins the bitstring. If the list is
 * unresolvable / unsigned / signed by the wrong issuer / mis-sized, `check()` returns `available:false` —
 * the caller denies. Never fails open.
 */
export class StatusListResolver {
  private cache: { bytes: Uint8Array; pin: StatusListPin; fetchedAt: number } | null = null;

  constructor(
    private readonly handle: KeymasterHandle,
    private readonly opts: { statusListCredential: string; expectedIssuer: string; maxAgeMs: number; clock?: () => number },
  ) {}

  /** The status list this resolver checks — for the recognition-points-at-the-right-list guard. */
  get statusListCredential(): string {
    return this.opts.statusListCredential;
  }

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  /** Prime the cache from a durable/last-known copy or in tests. */
  primeCache(bytes: Uint8Array, pin: StatusListPin, fetchedAt: number): void {
    this.cache = { bytes, pin, fetchedAt };
  }

  private async refresh(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const doc = await this.handle.keymaster.resolveDID(this.opts.statusListCredential);
      const list = (doc.didDocumentData ?? null) as SignedStatusList | null;
      if (!list || typeof list.encodedList !== 'string' || !list.proof) return { ok: false, reason: 'status list missing or malformed' };
      const verifyProof = this.handle.keymaster.verifyProof.bind(this.handle.keymaster) as (o: unknown) => Promise<boolean>;
      if (!(await verifyProof(list).catch(() => false))) return { ok: false, reason: 'status list signature does not verify' };
      const signer = (list.proof.verificationMethod ?? '').split('#')[0];
      if (signer !== this.opts.expectedIssuer) return { ok: false, reason: `status list signed by ${signer}, not the issuer ${this.opts.expectedIssuer}` };
      this.cache = { bytes: decodeBitstring(list.encodedList), pin: pinOf(this.opts.statusListCredential, doc), fetchedAt: this.now() };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `status list unresolvable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Is `statusListIndex` revoked? Fail-closed: `available:false` if the fact can't be established. */
  async check(statusListIndex: number): Promise<StatusCheck> {
    const fresh = this.cache !== null && this.now() - this.cache.fetchedAt < this.opts.maxAgeMs;
    if (!fresh) {
      const r = await this.refresh();
      if (!r.ok) return { available: false, revoked: false, reason: `fail-closed: ${r.reason}` };
    }
    const c = this.cache!;
    let revoked: boolean;
    try {
      revoked = getBit(c.bytes, statusListIndex);
    } catch (e) {
      return { available: false, revoked: false, reason: `fail-closed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { available: true, revoked, pin: c.pin };
  }
}

/**
 * Audit a pinned version: resolve the EXACT `versionSequence`, assert its `versionId` matches the pin, and
 * report whether the bit at `statusListIndex` was set in that historical list. Settles "was it revoked at
 * answer time".
 */
export async function auditRevocationAt(
  handle: KeymasterHandle,
  pin: StatusListPin,
  statusListIndex: number,
): Promise<{ versionIdMatches: boolean; revokedThen: boolean }> {
  const doc = await handle.keymaster.resolveDID(pin.statusListCredential, { versionSequence: pin.versionSequence });
  const meta = (doc.didDocumentMetadata ?? {}) as { versionId?: string };
  const list = (doc.didDocumentData ?? { encodedList: encodeBitstring(new Uint8Array(STATUS_LIST_BYTES)) }) as SignedStatusList;
  return { versionIdMatches: meta.versionId === pin.versionId, revokedThen: getBit(decodeBitstring(list.encodedList), statusListIndex) };
}
