import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IndexEntry } from '@hearthold/core';

/**
 * The Warden's recall index: embeddings + metadata for the Sovereign's artefacts, kept local in the
 * Warden's data folder. Holds **no plaintext** — content is re-unsealed transiently at recall time,
 * so the vault stays sealed at rest. A flat JSON file for v1 (→ sqlite-vec / a vector store later).
 */
export class IndexStore {
  private readonly file: string;

  constructor(dataFolder: string) {
    this.file = join(dataFolder, 'index.json');
  }

  private async readAll(): Promise<IndexEntry[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as IndexEntry[];
    } catch {
      return [];
    }
  }

  /** Add or replace the entry for an artefact (idempotent by artefactId). */
  async put(entry: IndexEntry): Promise<void> {
    await this.putMany([entry]);
  }

  /**
   * Bulk add/replace — ONE read + ONE write for the whole batch (idempotent by artefactId, last wins). Use
   * this for a large ingest (e.g. a book corpus): per-entry `put` re-reads + re-writes the whole file each
   * time (O(n²)); `putMany` is O(n). No-op on an empty batch.
   */
  async putMany(entries: IndexEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await mkdir(join(this.file, '..'), { recursive: true });
    const incoming = new Map(entries.map((e) => [e.artefactId, e]));
    const kept = (await this.readAll()).filter((e) => !incoming.has(e.artefactId));
    await writeFile(this.file, JSON.stringify([...kept, ...incoming.values()], null, 2), 'utf8');
  }

  async list(): Promise<IndexEntry[]> {
    return this.readAll();
  }

  async has(artefactId: string): Promise<boolean> {
    return (await this.readAll()).some((e) => e.artefactId === artefactId);
  }

  /** Remove index entries by artefactId. */
  async remove(artefactIds: string[]): Promise<void> {
    const drop = new Set(artefactIds);
    const kept = (await this.readAll()).filter((e) => !drop.has(e.artefactId));
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify(kept, null, 2), 'utf8');
  }
}
