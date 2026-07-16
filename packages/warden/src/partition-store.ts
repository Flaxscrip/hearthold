import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KeymasterHandle, CipherPublicJwk } from '@hearthold/core';

/** Marks a member's private partition within a space: `<spaceId>::priv:<sha16(ownerDid)>`. */
const PARTITION_MARKER = '::priv:';

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** The index `kb` tag identifying `ownerDid`'s private partition in `spaceId`. The one place this id is minted. */
export const partitionIdFor = (spaceId: string, ownerDid: string): string => `${spaceId}${PARTITION_MARKER}${sha16(ownerDid)}`;

/**
 * Does an artefact's `kb` tag belong to `spaceId` — either its shared partition or any member's private
 * one? Every space-scoped sweep must use this instead of `kb === spaceId`: the bare equality matches only
 * the shared partition, so a sweep silently skips all private content while reporting success. The marker
 * is part of the comparison, so a sibling space (`hearthold-kb-v2`) can never match `hearthold-kb`.
 */
export const belongsToSpace = (kb: string | undefined, spaceId: string): boolean =>
  kb === spaceId || (kb !== undefined && kb.startsWith(`${spaceId}${PARTITION_MARKER}`));

/**
 * Where a partition's data lives — the seam that makes KB Spaces location-abstract (docs/kb-spaces.md).
 * Phase 1: every partition is `local` (on this Warden's index/vault). Phase 2 (operator-private): a
 * member's private partition can be `remote` on the OWNER's own Warden, and recall federates to it over
 * DIDComm — same pattern, no rewrite.
 */
export interface PartitionLocation {
  kind: 'local' | 'remote';
  /** For `remote`: the DID of the Warden that holds this partition. */
  wardenDid?: string;
}

/** A member's private partition within a KB space (their private DB). Warden-private; never on the wire. */
export interface PartitionRecord {
  spaceId: string;
  /** The member's Sovereign DID — the sole read/write member of this partition. */
  owner: string;
  /** The index `kb` tag / scope id for this partition. */
  id: string;
  /** The GroupTrustRegistry group whose sole member is the owner (read + write). */
  group: string;
  location: PartitionLocation;
  createdAt: string;
  /**
   * Member-key encryption (guardianship-threat-model.md §0/§4a). The partition's PUBLIC key: the Warden
   * seals private content to it (write-host) but cannot decrypt at rest. Absent on pre-family partitions.
   */
  partitionPub?: CipherPublicJwk;
  /**
   * The partition PRIVATE key wrapped to the owner's DID key — only the member can unwrap it (or, per
   * session, rewrap it to a Warden ephemeral key for transient RAG). The Warden holds this blob but,
   * lacking the member's key, cannot open it.
   */
  wrappedKey?: string;
}

/**
 * The Warden-side store of per-member private partitions, keyed by `(spaceId, owner)`. Lives beside the
 * KB config + delegation records. Its contents never cross a boundary — recall reads it to compute a
 * member's visible set; nothing here is serialized into a credential or answer.
 */
export class PartitionStore {
  private readonly file: string;

  constructor(dataFolder: string) {
    this.file = join(dataFolder, 'hearthold-partitions.json');
  }

  private key(spaceId: string, owner: string): string {
    return `${spaceId}\0${owner}`;
  }

  private async all(): Promise<Record<string, PartitionRecord>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, PartitionRecord>;
    } catch {
      return {};
    }
  }

  /** The member's private partition in a space, or null if none has been provisioned. */
  async get(spaceId: string, owner: string): Promise<PartitionRecord | null> {
    return (await this.all())[this.key(spaceId, owner)] ?? null;
  }

  /** Every private partition in a space (operator view — e.g. for reset/teardown). */
  async listBySpace(spaceId: string): Promise<PartitionRecord[]> {
    return Object.values(await this.all()).filter((r) => r.spaceId === spaceId);
  }

  /** Every private partition owned by a member, across spaces — the member's set to unlock on login. */
  async listByOwner(owner: string): Promise<PartitionRecord[]> {
    return Object.values(await this.all()).filter((r) => r.owner === owner);
  }

  /** Record a freshly provisioned private partition (idempotent by (spaceId, owner)). */
  async put(rec: PartitionRecord): Promise<void> {
    const all = await this.all();
    all[this.key(rec.spaceId, rec.owner)] = rec;
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
}
