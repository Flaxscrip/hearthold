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
    // Content-addressed ids are idempotent — replace an existing entry rather than duplicating it.
    const all = (await this.readAll()).filter((a) => a.id !== artefact.id);
    all.push(artefact);
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
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
