/**
 * Durable, verifiable revocation for mesh recognitions — a RevocationList published as an Archon asset,
 * owned by the issuing Sovereign, resolvable and version-pinned.
 *
 * Replaces the in-memory `Set` on `MeshWarden`. In this architecture the issuer and the checker are the
 * SAME node (B's Sovereign issues, B's Warden checks), so the gaps this closes are not distribution but:
 *   - PERSISTENCE  — the list is an Archon asset, so a revocation survives a Warden restart;
 *   - MULTI-INSTANCE — every Warden for the Sovereign resolves the same asset;
 *   - VERIFIABILITY — the list is signed by the Sovereign; a holder can check its own status;
 *   - AUDITABILITY — Archon's `versionSequence` gives an immutable, content-addressed history for free, and
 *     the answer pins the exact version checked, so "you answered under a revoked recognition" is falsifiable.
 *
 * Archon stays dumb: it stores, versions, and controller-checks an opaque signed blob. It never understands
 * "revocation". Version pinning reuses the attenuation discipline exactly — record BOTH the integer
 * `versionSequence` and the content-addressed `versionId`, and assert they match on resolve. Fail-CLOSED
 * everywhere the fact is unavailable.
 */

import type { KeymasterHandle } from './keymaster.js';
import type { HearthholdConfig } from './config.js';

// ── Schemas ──────────────────────────────────────────────────────────────────────────────────────────

/** One revocation — an OPAQUE recognitionId + when it was revoked. NO holder/Emissary DIDs, no domains. */
export interface RevocationEntry {
  recognitionId: string;
  revokedAt: string;
}

/** The signed body the Sovereign owns as an Archon asset. */
export interface RevocationListBody {
  issuer: string;
  listVersion: number;
  entries: RevocationEntry[];
  updatedAt: string;
}

export interface SignedRevocationList extends RevocationListBody {
  proof?: { verificationMethod: string; proofValue: string; created: string; [k: string]: unknown };
}

/** A version-pinned reference to the list state that was checked — BOTH keys, asserted to match on resolve. */
export interface RevocationListPin {
  listDid: string;
  versionSequence: number;
  versionId: string;
  checkedAt: string;
}

// ── Issuer side ──────────────────────────────────────────────────────────────────────────────────────

/** Create an empty, signed RevocationList owned by the issuing Sovereign. Returns its DID + initial pin. */
export async function createRevocationList(
  issuer: KeymasterHandle,
  issuerName: string,
  config: HearthholdConfig,
): Promise<{ listDid: string; pin: RevocationListPin }> {
  const km = issuer.keymaster;
  await km.setCurrentId(issuerName);
  const issuerDid = (await km.resolveDID(issuerName)).didDocument?.id ?? '';
  const body: RevocationListBody = { issuer: issuerDid, listVersion: 1, entries: [], updatedAt: new Date().toISOString() };
  const signed = await km.addProof(body, issuerName);
  const listDid = await km.createAsset(signed, { registry: config.registry });
  const meta = ((await km.resolveDID(listDid)).didDocumentMetadata ?? {}) as { versionId?: string; versionSequence?: string };
  return { listDid, pin: { listDid, versionSequence: Number(meta.versionSequence ?? 0), versionId: meta.versionId ?? '', checkedAt: new Date().toISOString() } };
}

/**
 * Revoke a recognition — append the entry and update the asset. Idempotent: revoking one already present is
 * not an error and mints no new version. Returns the pin of the resulting (or existing) list version.
 */
export async function publishRevocation(
  issuer: KeymasterHandle,
  issuerName: string,
  listDid: string,
  recognitionId: string,
  config: HearthholdConfig,
): Promise<{ pin: RevocationListPin; listVersion: number; alreadyRevoked: boolean }> {
  const km = issuer.keymaster;
  await km.setCurrentId(issuerName);
  const issuerDid = (await km.resolveDID(issuerName)).didDocument?.id ?? '';
  const doc = await km.resolveDID(listDid);
  const cur = (doc.didDocumentData ?? {}) as SignedRevocationList;
  const entries: RevocationEntry[] = Array.isArray(cur.entries) ? [...cur.entries] : [];
  const pinOf = (d: { didDocumentMetadata?: unknown }): RevocationListPin => {
    const m = (d.didDocumentMetadata ?? {}) as { versionId?: string; versionSequence?: string };
    return { listDid, versionSequence: Number(m.versionSequence ?? 0), versionId: m.versionId ?? '', checkedAt: new Date().toISOString() };
  };

  if (entries.some((e) => e.recognitionId === recognitionId)) {
    return { pin: pinOf(doc), listVersion: cur.listVersion ?? 0, alreadyRevoked: true };
  }
  entries.push({ recognitionId, revokedAt: new Date().toISOString() });
  const listVersion = (cur.listVersion ?? 0) + 1;
  const body: RevocationListBody = { issuer: issuerDid, listVersion, entries, updatedAt: new Date().toISOString() };
  const signed = (await km.addProof(body, issuerName)) as unknown as Record<string, unknown>;
  await km.mergeData(listDid, signed); // controller-signed update → new version
  return { pin: pinOf(await km.resolveDID(listDid)), listVersion, alreadyRevoked: false };
}

// ── Checker side (resolver with max-age cache + fail-closed + version pin) ──────────────────────────────

export interface RevocationCheck {
  /** FALSE ⇒ the fact is unavailable and the caller MUST fail closed (deny). */
  available: boolean;
  revoked: boolean;
  /** The version pinned at check time — bound into the answer for after-the-fact dispute. */
  pin?: RevocationListPin;
  reason?: string;
}

/**
 * Resolves the issuer's RevocationList with a max-age cache and FAIL-CLOSED semantics. On a cache miss it
 * re-resolves, verifies the Sovereign's signature, and pins `{versionSequence, versionId}`. If the list is
 * unresolvable / unsigned / signed by the wrong issuer, `check()` returns `available:false` — the caller
 * denies. Never fails open.
 */
export class RevocationResolver {
  private cache: { list: SignedRevocationList; pin: RevocationListPin; fetchedAt: number } | null = null;

  constructor(
    private readonly handle: KeymasterHandle,
    private readonly opts: { listDid: string; expectedIssuer: string; maxAgeMs: number; clock?: () => number },
  ) {}

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  /** Prime the cache from a durable/last-known copy (e.g. on restart) or in tests. */
  primeCache(list: SignedRevocationList, pin: RevocationListPin, fetchedAt: number): void {
    this.cache = { list, pin, fetchedAt };
  }

  private async refresh(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const doc = await this.handle.keymaster.resolveDID(this.opts.listDid);
      const list = (doc.didDocumentData ?? null) as SignedRevocationList | null;
      const meta = (doc.didDocumentMetadata ?? {}) as { versionId?: string; versionSequence?: string };
      if (!list || !Array.isArray(list.entries) || !list.proof) return { ok: false, reason: 'revocation list missing or malformed' };
      const verifyProof = this.handle.keymaster.verifyProof.bind(this.handle.keymaster) as (o: unknown) => Promise<boolean>;
      if (!(await verifyProof(list).catch(() => false))) return { ok: false, reason: 'revocation list signature does not verify' };
      const signer = (list.proof.verificationMethod ?? '').split('#')[0];
      if (signer !== this.opts.expectedIssuer) return { ok: false, reason: `revocation list signed by ${signer}, not the issuer ${this.opts.expectedIssuer}` };
      const pin: RevocationListPin = { listDid: this.opts.listDid, versionSequence: Number(meta.versionSequence ?? 0), versionId: meta.versionId ?? '', checkedAt: new Date(this.now()).toISOString() };
      this.cache = { list, pin, fetchedAt: this.now() };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `revocation list unresolvable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Is `recognitionId` revoked? Fail-closed: `available:false` if the fact can't be established. */
  async check(recognitionId: string): Promise<RevocationCheck> {
    const fresh = this.cache !== null && this.now() - this.cache.fetchedAt < this.opts.maxAgeMs;
    if (!fresh) {
      const r = await this.refresh();
      if (!r.ok) return { available: false, revoked: false, reason: `fail-closed: ${r.reason}` };
    }
    const c = this.cache!;
    return { available: true, revoked: c.list.entries.some((e) => e.recognitionId === recognitionId), pin: c.pin };
  }
}

/**
 * Audit a pinned version: resolve the EXACT `versionSequence`, assert its `versionId` matches the pin, and
 * report whether `recognitionId` was present in that historical list. Settles "was it revoked at answer time".
 */
export async function auditRevocationAt(
  handle: KeymasterHandle,
  pin: RevocationListPin,
  recognitionId: string,
): Promise<{ versionIdMatches: boolean; revokedThen: boolean }> {
  const doc = await handle.keymaster.resolveDID(pin.listDid, { versionSequence: pin.versionSequence });
  const meta = (doc.didDocumentMetadata ?? {}) as { versionId?: string };
  const list = (doc.didDocumentData ?? { entries: [] }) as SignedRevocationList;
  return {
    versionIdMatches: meta.versionId === pin.versionId,
    revokedThen: (list.entries ?? []).some((e) => e.recognitionId === recognitionId),
  };
}
