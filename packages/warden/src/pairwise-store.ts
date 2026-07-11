import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KeymasterHandle, PairwiseStore, PairwiseRecord } from '@hearthold/core';

/**
 * The Warden's file-backed store of pairwise↔Sovereign linkages — beside `delegations.json`. It maps
 * an audience to the fresh pairwise DID minted for it (and back), so a repeat grant to the same
 * counterparty reuses one pairwise DID. The file is Warden-private: nothing here is ever serialized
 * into a credential, evidence graph, or summary — the minting paths read it only to resolve/enforce.
 */
export class FilePairwiseStore implements PairwiseStore {
  private readonly file: string;

  constructor(private readonly warden: KeymasterHandle) {
    this.file = join(warden.dataFolder, 'pairwise.json');
  }

  private async readAll(): Promise<PairwiseRecord[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as PairwiseRecord[];
    } catch {
      return [];
    }
  }

  async find(audience: string): Promise<PairwiseRecord | null> {
    return (await this.readAll()).find((r) => r.audience === audience) ?? null;
  }

  async get(pairwiseDid: string): Promise<PairwiseRecord | null> {
    return (await this.readAll()).find((r) => r.pairwiseDid === pairwiseDid) ?? null;
  }

  async record(rec: PairwiseRecord): Promise<void> {
    await mkdir(this.warden.dataFolder, { recursive: true });
    const all = await this.readAll();
    // Idempotent by audience — one audience ↔ one pairwise DID.
    if (all.some((r) => r.audience === rec.audience)) return;
    all.push(rec);
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
}
