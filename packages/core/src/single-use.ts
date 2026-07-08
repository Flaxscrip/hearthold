/**
 * Single-use enforcement — "scrolls burn."
 *
 * A `HearthholdAttestation` carries a single-use `txn` (in its `credentialSubject` and `termsOfUse`).
 * The mint declares it; THIS is where a verifier enforces it: after a presentation verifies, its txn is
 * recorded spent, and a second presentation of the same scroll is refused. Verifier-side state, so the
 * holder cannot reset it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SpentTxnStore {
  isSpent(txn: string): Promise<boolean>;
  markSpent(txn: string): Promise<void>;
}

/** File-backed spent-txn ledger in a verifier's data folder. */
export class FileSpentTxnStore implements SpentTxnStore {
  private readonly file: string;

  constructor(dataFolder: string) {
    this.file = join(dataFolder, 'spent-txns.json');
  }

  private async all(): Promise<string[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as string[];
    } catch {
      return [];
    }
  }

  async isSpent(txn: string): Promise<boolean> {
    return (await this.all()).includes(txn);
  }

  async markSpent(txn: string): Promise<void> {
    const all = await this.all();
    if (all.includes(txn)) return;
    all.push(txn);
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
}

/** In-memory spent-txn ledger (tests / a single verifier process). */
export class MemorySpentTxnStore implements SpentTxnStore {
  private readonly spent = new Set<string>();
  async isSpent(txn: string): Promise<boolean> {
    return this.spent.has(txn);
  }
  async markSpent(txn: string): Promise<void> {
    this.spent.add(txn);
  }
}
