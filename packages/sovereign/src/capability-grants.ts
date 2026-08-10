/**
 * The Sovereign's capability-grant inventory — the "permissions center" (Phase 4).
 *
 * When the Sovereign grants an Emissary a scope capability it records the grant here, keyed by credential DID
 * and carrying the status-list index it allocated. That index is what makes revocation a local, O(1) act: the
 * Sovereign sets the bit (`revokeStatusIndex`) and the Warden's revocation-by-default check denies the
 * capability at the next invocation — without the Sovereign needing to hold or decrypt the issued VC.
 *
 * We allocate the status index EXPLICITLY here (rather than via `issueScopeCapability`'s config auto-allocate)
 * precisely so the issuer knows the index to record and later revoke.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  ensureCapabilityStatusContext,
  ensureAuthorizationSchema,
  issueScopeCapability,
  mintRootCapability,
  allocateIndex,
  revokeStatusIndex,
  STATUS_LIST_LENGTH,
  type KeymasterHandle,
  type HearthholdConfig,
  type Sensitivity,
  type WitnessKind,
  type ChainCapabilityGrant,
} from '@hearthold/core';

export interface CapabilityGrant {
  credentialDid: string;
  /** The Emissary the capability was granted to. */
  holder: string;
  target: string;
  kinds?: WitnessKind[];
  ceiling: Sensitivity;
  expires: string;
  /** The schema DID the capability was issued against (the one a verifier's challenge requests). */
  schemaDid: string;
  /** The revocation pointer the issuer holds — how a grant is revoked without decrypting the issued VC. */
  statusListCredential: string;
  statusListIndex: number;
  issuedAt: string;
  /** Set when revoked (the bit was flipped in the status list). */
  revokedAt?: string;
}

/** File-backed grant inventory in the Sovereign's data folder. */
export class CapabilityGrantStore {
  private readonly file: string;
  constructor(private readonly dataFolder: string) {
    this.file = join(dataFolder, 'capability-grants.json');
  }
  private async all(): Promise<CapabilityGrant[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as CapabilityGrant[];
    } catch {
      return [];
    }
  }
  async put(g: CapabilityGrant): Promise<void> {
    await mkdir(this.dataFolder, { recursive: true });
    const all = (await this.all()).filter((x) => x.credentialDid !== g.credentialDid);
    all.push(g);
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
  async list(): Promise<CapabilityGrant[]> {
    return this.all();
  }
  async get(credentialDid: string): Promise<CapabilityGrant | undefined> {
    return (await this.all()).find((g) => g.credentialDid === credentialDid);
  }
  async markRevoked(credentialDid: string): Promise<CapabilityGrant | undefined> {
    const all = await this.all();
    const g = all.find((x) => x.credentialDid === credentialDid);
    if (g && !g.revokedAt) {
      g.revokedAt = new Date().toISOString();
      await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
    }
    return g;
  }
}

export interface GrantSpec {
  holder: string;
  target?: string;
  kinds?: WitnessKind[];
  ceiling: Sensitivity;
  days?: number;
}

/** Issue a revocable scope capability to `spec.holder`, recording it in the inventory. Returns the record. */
export async function grantCapability(
  sovereign: KeymasterHandle,
  issuerName: string,
  sovereignDid: string,
  config: HearthholdConfig,
  spec: GrantSpec,
  store: CapabilityGrantStore,
): Promise<CapabilityGrant> {
  const target = spec.target ?? 'hearthold:vault';
  const days = spec.days ?? 90;
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  // Allocate the status index EXPLICITLY so we know it (to record + later revoke). `issueScopeCapability`
  // honors an explicit caveats.status over its own auto-allocate.
  const ctx = await ensureCapabilityStatusContext(sovereign, issuerName, config);
  const { index } = await allocateIndex(sovereign, issuerName, ctx.allocationRecord, randomUUID(), STATUS_LIST_LENGTH);
  const status = { statusListCredential: ctx.statusListCredential, statusListIndex: index };

  // Issue against the SHARED schema DID the verifier requests — not our own, since schema DIDs are not
  // content-addressed across wallets. In a multi-wallet deployment `config.authorizationSchemaDid` carries the
  // Warden's canonical schema DID; in single-wallet dev we derive it (issuer and verifier are the same wallet).
  const schemaDid = config.authorizationSchemaDid ?? (await ensureAuthorizationSchema(sovereign));
  const credentialDid = await issueScopeCapability({
    issuer: sovereign,
    issuerName,
    holder: spec.holder,
    schemaDid,
    scope: {
      invocationTarget: target,
      authority: { operations: ['prove'], resources: [target] },
      caveats: { ceiling: spec.ceiling, owner: sovereignDid, expires, ...(spec.kinds ? { kinds: spec.kinds } : {}), status },
    },
    validUntil: expires,
  });

  const grant: CapabilityGrant = {
    credentialDid,
    holder: spec.holder,
    target,
    ...(spec.kinds ? { kinds: spec.kinds } : {}),
    ceiling: spec.ceiling,
    expires,
    schemaDid,
    statusListCredential: status.statusListCredential,
    statusListIndex: index,
    issuedAt: new Date().toISOString(),
  };
  await store.put(grant);
  return grant;
}

export interface RootGrantSpec {
  /** The agent's Emissary DID that will HOLD (invoke + further-delegate) this root. */
  holder: string;
  target?: string;
  kinds?: WitnessKind[];
  ceiling: Sensitivity;
  /** Operations the holder may exercise/re-delegate. Default `['prove','submit']` — prove facts, and the
   *  delegate side narrows to `prove` when handing onward. */
  operations?: string[];
}

/**
 * Mint a ROOT chain-capability held by `spec.holder` (an agent's Emissary), with a revocable status from the
 * Sovereign's list, recorded in the inventory so it lists + revokes like any grant. Returns the transferable
 * `ChainCapabilityGrant` (the caller sends it to the holder over DIDComm as a `hearthold/chain-grant`) + its
 * record. This is the family root-of-authority: the Sovereign seeds an agent, which then delegates onward.
 *
 * NB: the root caveats carry NO `expires` (unbounded) so a child without an expiry can still narrow it
 * (`caveatsNarrow`); the record's `expires` is a far-future display value only. Revocation is by status bit.
 */
export async function mintRootGrant(
  sovereign: KeymasterHandle,
  issuerName: string,
  sovereignDid: string,
  config: HearthholdConfig,
  spec: RootGrantSpec,
  store: CapabilityGrantStore,
): Promise<{ grant: ChainCapabilityGrant; record: CapabilityGrant }> {
  const target = spec.target ?? 'hearthold:vault';
  const ctx = await ensureCapabilityStatusContext(sovereign, issuerName, config);
  const { index } = await allocateIndex(sovereign, issuerName, ctx.allocationRecord, randomUUID(), STATUS_LIST_LENGTH);
  const root = await mintRootCapability({
    issuer: sovereign,
    issuerName,
    holder: spec.holder,
    capability: {
      invocationTarget: target,
      authority: { operations: spec.operations ?? ['prove', 'submit'], resources: [target] },
      caveats: { ceiling: spec.ceiling, owner: sovereignDid, ...(spec.kinds ? { kinds: spec.kinds } : {}), status: { statusListCredential: ctx.statusListCredential, statusListIndex: index } },
    },
    registry: config.registry,
  });
  const record: CapabilityGrant = {
    credentialDid: root.issued.vcDid,
    holder: spec.holder,
    target,
    ...(spec.kinds ? { kinds: spec.kinds } : {}),
    ceiling: spec.ceiling,
    expires: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString(), // display only — the root is unbounded
    schemaDid: '', // a root is an Asset-DID chain, not a schema'd VC
    statusListCredential: ctx.statusListCredential,
    statusListIndex: index,
    issuedAt: new Date().toISOString(),
  };
  await store.put(record);
  return { grant: { handle: root, ancestorDisclosures: {} }, record };
}

/** Revoke a granted capability by DID: flip its status bit and mark the record. Fails closed on an unknown DID. */
export async function revokeCapability(
  sovereign: KeymasterHandle,
  issuerName: string,
  store: CapabilityGrantStore,
  credentialDid: string,
): Promise<{ revoked: boolean; reason?: string }> {
  const g = await store.get(credentialDid);
  if (!g) return { revoked: false, reason: 'not found in the grant inventory' };
  if (g.revokedAt) return { revoked: true }; // idempotent
  await revokeStatusIndex(sovereign, issuerName, g.statusListCredential, g.statusListIndex);
  await store.markRevoked(credentialDid);
  return { revoked: true };
}

/** A view of a grant's lifecycle state (for the inventory UI). */
export function grantState(g: CapabilityGrant, now = Date.now()): 'revoked' | 'expired' | 'active' {
  if (g.revokedAt) return 'revoked';
  if (Date.parse(g.expires) <= now) return 'expired';
  return 'active';
}
