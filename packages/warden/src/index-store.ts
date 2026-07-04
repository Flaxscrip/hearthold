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
    await mkdir(join(this.file, '..'), { recursive: true });
    const all = (await this.readAll()).filter((e) => e.artefactId !== entry.artefactId);
    all.push(entry);
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }

  async list(): Promise<IndexEntry[]> {
    return this.readAll();
  }

  async has(artefactId: string): Promise<boolean> {
    return (await this.readAll()).some((e) => e.artefactId === artefactId);
  }
}
