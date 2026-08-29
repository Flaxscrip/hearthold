import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Sensitivity, WitnessKind } from '@hearthold/core';

/** A stored artefact record. Payload stays encrypted; only metadata is in the clear here. */
export interface Artefact {
  id: string;
  kind: WitnessKind;
  observedAt: string;
  storedAt: string;
  sensitivity: Sensitivity;
  /** Sealed payload — bare ciphertext addressed to the Warden. Never plaintext. */
  ciphertext: string;
  metadata: Record<string, unknown>;
  /** Household member DID this artefact belongs to. Attributed on submit (Phase 1); backfilled to the
   *  configured Sovereign for pre-family data. Undefined = not yet attributed (treated as the Sovereign's). */
  owner?: string;
  /** Partition origin: the shared household pool, or the owner's private partition. Default 'private'. */
  scope?: 'shared' | 'private';
  /**
   * Which key seals `ciphertext`. Absent = the Warden's own key (`sealForWarden` / `unsealAsWarden`, the
   * default). `{ partition }` = a member-partition public key (`sealToKey`) the Warden CANNOT open at rest;
   * a reader needs the member's session-rewrapped key (`openWithKey`). Set only by the member-key write
   * path (Phase 6 cutover); the resolver in `recall.ts` routes on it.
   */
  sealedTo?: { partition: string };
}

/**
 * Minimal file-backed vault store for v1. The index (vector + structured metadata) will grow on
 * top of this; for now it is a single JSON file under the Warden's data folder.
 */
export class VaultStore {
  private readonly file: string;

  constructor(private readonly dataFolder: string) {
    this.file = join(dataFolder, 'vault.json');
  }

  private async readAll(): Promise<Artefact[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Artefact[];
    } catch {
      return [];
    }
  }

  async put(artefact: Artefact): Promise<void> {
    await this.putMany([artefact]);
  }

  /**
   * Bulk add/replace — ONE read + ONE write for the whole batch (idempotent by content id, last wins). Use
   * for a large ingest (e.g. a book corpus): per-item `put` re-reads + re-writes the whole vault each time
   * (O(n²)); `putMany` is O(n). No-op on an empty batch.
   */
  async putMany(artefacts: Artefact[]): Promise<void> {
    if (artefacts.length === 0) return;
    await mkdir(this.dataFolder, { recursive: true });
    const incoming = new Map(artefacts.map((a) => [a.id, a]));
    const kept = (await this.readAll()).filter((a) => !incoming.has(a.id));
    await writeFile(this.file, JSON.stringify([...kept, ...incoming.values()], null, 2), 'utf8');
  }

  async get(id: string): Promise<Artefact | undefined> {
    return (await this.readAll()).find((a) => a.id === id);
  }

  async list(): Promise<Artefact[]> {
    return this.readAll();
  }

  /** Remove artefacts by id. Returns how many were removed. */
  async remove(ids: string[]): Promise<number> {
    const drop = new Set(ids);
    const all = await this.readAll();
    const kept = all.filter((a) => !drop.has(a.id));
    await mkdir(this.dataFolder, { recursive: true });
    await writeFile(this.file, JSON.stringify(kept, null, 2), 'utf8');
    return all.length - kept.length;
  }
}
