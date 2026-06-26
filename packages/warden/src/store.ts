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
    await mkdir(this.dataFolder, { recursive: true });
    const all = await this.readAll();
    all.push(artefact);
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }

  async get(id: string): Promise<Artefact | undefined> {
    return (await this.readAll()).find((a) => a.id === id);
  }

  async list(): Promise<Artefact[]> {
    return this.readAll();
  }
}
