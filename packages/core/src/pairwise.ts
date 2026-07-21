/**
 * Pairwise DIDs — one engine, two masters (CGPR grants + DTG R-DIDs).
 *
 * DTG v0.3 hardened R-DID-per-relationship to a MUST ("each entity MUST generate a new, unique R-DID
 * for every single entity they connect with"); CGPR forbids handing a counterparty a reusable subject
 * identifier before the Sovereign's deliberate choice. Same rule, two specs: the identity a Sovereign
 * exposes to a counterparty is, by default, a FRESH pairwise DID minted for that audience — never the
 * Sovereign's stable DID.
 *
 * Layering (the Bitcoin / HD-wallet precedent). **L0 Keymaster** supplies the mechanism — `createId` is
 * BIP44-derived, so per-relationship key material is already seed-recoverable — but never the MUST (it
 * can't know what a "relationship" is; plenty of DIDs are legitimately stable). **L1 Hearthold**
 * enforces the MUST as Warden law: `enforcePairwiseSubject` refuses a non-pairwise identity unless the
 * governed actor's active Ruleset carries a signed exception for that audience.
 *
 * The pairwise→Sovereign linkage lives ONLY in the Warden-side `PairwiseStore`; it is disclosed never
 * and excluded from every evidence graph and summary by construction (no minting path reads it back
 * into a credential). Transport-free; the store is injected.
 */

import { createHash } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import type { SignedRuleset } from './ruleset.js';

/** A pairwise DID minted for one audience, standing in for the Sovereign. Warden-private. */
export interface PairwiseRecord {
  /** The counterparty/audience this pairwise DID is bound to (e.g. C's DID or Agent Card URL). */
  audience: string;
  /** The fresh, wallet-controlled DID exposed to that audience. */
  pairwiseDid: string;
  /** The wallet id name that holds it (so the holder can present / revoke). */
  name: string;
  /** The Sovereign (or stable issuer) it stands in for — NEVER disclosed. */
  subjectDid: string;
  /**
   * Which wallet holds this R-DID's private key. `'warden'` (default) — the custodian minted it and
   * presents on the Sovereign's behalf (disclosure pairwise: showing evidence to a verifier). `'subject'`
   * — minted in the Sovereign's OWN (Signet) wallet, so the Sovereign proves control DIRECTLY with their
   * own key. Identity-bearing relationships (a bank that KYCs the DID and issues credentials to it) MUST
   * be `'subject'`: a custodian signing on your behalf is the wrong trust shape for an identity anchor.
   * Absent on legacy records ⇒ treated as `'warden'`.
   */
  keyHolder?: 'warden' | 'subject';
  createdAt: string;
}

/**
 * The Warden-side store of pairwise↔Sovereign linkages. Lives beside the delegation records. Its
 * contents cross no boundary: no credential, evidence graph, or summary ever serializes a record.
 */
export interface PairwiseStore {
  /** The pairwise record for an audience, if one has been minted (one audience ↔ one pairwise DID). */
  find(audience: string): Promise<PairwiseRecord | null>;
  /** The record for a given pairwise DID, or null if `did` is not one we minted. */
  get(pairwiseDid: string): Promise<PairwiseRecord | null>;
  /** Persist a freshly minted linkage. */
  record(rec: PairwiseRecord): Promise<void>;
}

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Deterministic wallet id name for an audience's pairwise DID (keeps minting idempotent). */
export function pairwiseName(audience: string): string {
  return `pw-${sha16(audience)}`;
}

/**
 * Resolve the pairwise DID for an audience — idempotent (one audience ↔ one pairwise DID). On first
 * contact it mints a fresh wallet-controlled DID (seed-recoverable, per L0) and records the linkage;
 * afterwards it returns the existing one. The wallet's current id is preserved.
 */
export async function resolvePairwiseDid(
  handle: KeymasterHandle,
  store: PairwiseStore,
  args: {
    audience: string;
    subjectDid: string;
    createdAt: string;
    registry?: string;
    /**
     * Who holds the minted key. Defaults to `'warden'` (the historical disclosure-pairwise behaviour).
     * Pass `'subject'` AND the Sovereign's own handle to mint an identity-bearing R-DID the Sovereign
     * controls directly (banking / KYC relationships) — see `PairwiseRecord.keyHolder`.
     */
    keyHolder?: 'warden' | 'subject';
  },
): Promise<PairwiseRecord> {
  const existing = await store.find(args.audience);
  if (existing) return existing;

  const name = pairwiseName(args.audience);
  const km = handle.keymaster;
  const prev = await km.getCurrentId().catch(() => undefined);
  const ids = (await km.listIds().catch(() => [])) as string[];
  if (!ids.includes(name)) {
    await km.createId(name, args.registry ? { registry: args.registry } : undefined);
  }
  await km.setCurrentId(name);
  const doc = await km.resolveDID(name);
  const pairwiseDid = doc.didDocument?.id ?? '';
  if (prev) await km.setCurrentId(prev);
  if (!pairwiseDid) throw new Error(`failed to mint pairwise DID for audience ${args.audience}`);

  const rec: PairwiseRecord = {
    audience: args.audience,
    pairwiseDid,
    name,
    subjectDid: args.subjectDid,
    keyHolder: args.keyHolder ?? 'warden',
    createdAt: args.createdAt,
  };
  await store.record(rec);
  return rec;
}

/**
 * Prove control of a wallet-held DID by answering a counterparty's challenge WITH THAT DID's key
 * (challenge/response). For a subject-keyed R-DID this is how the Sovereign proves control to a bank
 * DIRECTLY — the Signet signs the bank's challenge with the R-DID it holds; no custodian is in the
 * signing path. Only succeeds if `name` is an identity in `handle`'s wallet (a Warden that never minted
 * the key cannot answer), which is exactly the property a KYC'ing institution needs.
 *
 * Registry hygiene: the response DID is ephemeral — pass `config.registry` so it anchors on a reachable
 * registry rather than defaulting to hyperswarm.
 */
export async function proveControl(
  handle: KeymasterHandle,
  name: string,
  challengeDid: string,
  opts: { registry?: string } = {},
): Promise<string> {
  const km = handle.keymaster;
  const prev = await km.getCurrentId().catch(() => undefined);
  await km.setCurrentId(name);
  try {
    return await km.createResponse(challengeDid, opts.registry ? { registry: opts.registry } : undefined);
  } finally {
    if (prev) await km.setCurrentId(prev);
  }
}

/** Is `did` a pairwise DID we minted for some audience? */
export async function isPairwiseDid(store: PairwiseStore, did: string): Promise<boolean> {
  return (await store.get(did)) != null;
}

export interface PairwiseGate {
  ok: boolean;
  reason: string;
}

/**
 * The release-path chokepoint (§3 of the A2A brief). The identity a Sovereign exposes to a counterparty
 * — the subject of a CGPR grant, or the issuer R-DID of a DTG VRC — MUST be pairwise, UNLESS the
 * actor's active Ruleset carries a signed exception naming this audience (`stableDidAudiences`). Fail
 * closed: no active Ruleset ⇒ no exception. Call this at the mint chokepoint, never in the callers, so
 * no future surface can forget it.
 */
export function enforcePairwiseSubject(args: {
  subjectDid: string;
  audience: string;
  isPairwise: boolean;
  activeRuleset: SignedRuleset | null;
}): PairwiseGate {
  if (args.isPairwise) return { ok: true, reason: 'pairwise subject' };
  const allowed = args.activeRuleset?.capabilities.stableDidAudiences ?? [];
  if (allowed.includes(args.audience)) {
    return { ok: true, reason: `stable subject permitted by a signed Ruleset exception for '${args.audience}'` };
  }
  return {
    ok: false,
    reason:
      `refused: a non-pairwise subject requires a signed Ruleset exception for audience '${args.audience}' ` +
      `(DTG v0.3 R-DID-per-relationship MUST / CGPR deliberate-choice)`,
  };
}

/** In-memory PairwiseStore — for tests and ephemeral flows (mirrors `MemorySpentTxnStore`). */
export class MemoryPairwiseStore implements PairwiseStore {
  private readonly byAudience = new Map<string, PairwiseRecord>();
  private readonly byDid = new Map<string, PairwiseRecord>();
  async find(audience: string): Promise<PairwiseRecord | null> {
    return this.byAudience.get(audience) ?? null;
  }
  async get(pairwiseDid: string): Promise<PairwiseRecord | null> {
    return this.byDid.get(pairwiseDid) ?? null;
  }
  async record(rec: PairwiseRecord): Promise<void> {
    this.byAudience.set(rec.audience, rec);
    this.byDid.set(rec.pairwiseDid, rec);
  }
}
