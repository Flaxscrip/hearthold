import type { HearthholdConfig, KeymasterHandle } from '@hearthold/core';

/**
 * The shared household partition, realized as an **Archon Vault** (the native multi-member encrypted
 * store). PVM separation:
 *   - the WARDEN owns the vault (the custodian holds the shared data, and only the owner writes/admits —
 *     `checkVaultOwner` is enforced inside keymaster);
 *   - household members are Vault MEMBERS → membership grants shared READ (decrypt) — the native
 *     "read-only member" default;
 *   - the MASTER-SOVEREIGN (governor) authorizes admit/remove + contribution tiers via its signed
 *     Ruleset; the Warden EXECUTES those changes under that authorization (Phase 4). This wrapper is the
 *     execution surface only — it does not itself gate; callers apply the governance/step-up checks.
 *
 * Content is encrypted once to the vault key and that key is wrapped per member (Archon `addMemberKey`),
 * so a non-member — including another household's member — cannot decrypt it. Created on the configured
 * registry (`local` in dev — registry hygiene).
 */
export class HouseholdVault {
  constructor(
    private readonly handle: KeymasterHandle,
    /** The Archon Vault DID (the shared partition). */
    public readonly did: string,
  ) {}

  /** Provision a fresh Warden-owned shared vault. Returns the wrapper (persist `.did` in the household config). */
  static async create(handle: KeymasterHandle, config: HearthholdConfig): Promise<HouseholdVault> {
    const did = await handle.keymaster.createVault({ registry: config.registry });
    return new HouseholdVault(handle, did);
  }

  /** Admit a member → grants shared READ (they can decrypt shared items). Owner-only op (Warden-executed). */
  async admit(memberDid: string): Promise<boolean> {
    return this.handle.keymaster.addVaultMember(this.did, memberDid);
  }

  /** Remove a member → revokes shared read. Owner-only op (Warden-executed under governor authorization). */
  async remove(memberDid: string): Promise<boolean> {
    return this.handle.keymaster.removeVaultMember(this.did, memberDid);
  }

  /** The household roster — member DIDs with shared read access. */
  async members(): Promise<string[]> {
    return Object.keys(await this.handle.keymaster.listVaultMembers(this.did));
  }

  /** Whether `memberDid` currently has shared read access (drives the visible-set union in recall). */
  async isMember(memberDid: string): Promise<boolean> {
    const members = await this.handle.keymaster.listVaultMembers(this.did);
    return Object.prototype.hasOwnProperty.call(members, memberDid);
  }

  /**
   * Write an item into the shared pool (owner-write; the Warden is the owner). The caller MUST have already
   * checked the sharer's contributor tier AND run the item's sensitivity step-up (Phase 4). `name` is the
   * item key (e.g. the source artefact id).
   */
  async share(name: string, content: string): Promise<boolean> {
    return this.handle.keymaster.addVaultItem(this.did, name, Buffer.from(content, 'utf8'));
  }

  /** Read a shared item's plaintext, or null if absent. */
  async read(name: string): Promise<string | null> {
    const buf = await this.handle.keymaster.getVaultItem(this.did, name);
    return buf ? Buffer.from(buf).toString('utf8') : null;
  }

  /** The shared item keys (for indexing shared content into recall with scope:'shared'). */
  async itemNames(): Promise<string[]> {
    return Object.keys(await this.handle.keymaster.listVaultItems(this.did));
  }
}
