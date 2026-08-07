/**
 * Single-use enforcement — "scrolls burn."
 *
 * A `HearthholdAttestation` carries a single-use `txn` (in its `credentialSubject` and `termsOfUse`).
 * The mint declares it; THIS is where a verifier enforces it: after a presentation verifies, its txn is
 * recorded spent, and a second presentation of the same scroll is refused. Verifier-side state, so the
 * holder cannot reset it.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; // no ledger yet → nothing spent
      throw e; // an UNREADABLE ledger must not read as "nothing spent" — fail closed (a spent txn would replay)
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // A truncated/corrupt ledger (e.g. a crash mid-write on the old non-atomic path) must fail closed, not
      // silently return [] and re-open every burned txn.
      throw new Error(`spent-txn ledger is unparseable (refusing to fail open): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(parsed)) throw new Error('spent-txn ledger is not a JSON array (refusing to fail open)');
    return parsed as string[];
  }

  async isSpent(txn: string): Promise<boolean> {
    return (await this.all()).includes(txn);
  }

  async markSpent(txn: string): Promise<void> {
    const all = await this.all();
    if (all.includes(txn)) return;
    all.push(txn);
    await mkdir(join(this.file, '..'), { recursive: true });
    // Atomic: write a temp then rename over the target, so a crash mid-write leaves the old ledger intact
    // (never a truncated file that would read as "nothing spent"). rename(2) is atomic on the same filesystem.
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
    await rename(tmp, this.file);
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
