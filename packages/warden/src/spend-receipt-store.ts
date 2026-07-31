/**
 * The Warden's SPEND observation feed — a file-backed log of agent-family spend receipts (the parent's
 * passive "who spent what" view). Autonomous notify-mode settlements never enter the Signet's `pending[]`,
 * so this is the only place they surface; gated spends land here too once settled.
 *
 * File-backed on purpose: the process that runs `authorizeSpend` + the Lightning settlement (the family
 * harness / a future in-Warden spend route) appends via `record`; the Warden control daemon serves them
 * over `GET /api/spend/receipts` from the SAME data root. Same pattern as `GuardianReceiptStore`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SpendReceipt } from '@hearthold/control-types';

export class SpendReceiptStore {
  private readonly file: string;
  constructor(dataFolder: string) {
    this.file = join(dataFolder, 'spend-receipts.json');
  }

  private async all(): Promise<SpendReceipt[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as SpendReceipt[];
    } catch {
      return [];
    }
  }

  /** Append a settled/decided receipt. Enforces the fail-closed invariant (`!approved ⇒ !paid`). */
  async record(r: SpendReceipt): Promise<void> {
    const receipt: SpendReceipt = r.approved ? r : { ...r, paid: false };
    const a = await this.all();
    a.push(receipt);
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify(a, null, 2), 'utf8');
  }

  /** Most-recent-first, capped (the passive feed the Table renders). */
  async list(limit = 100): Promise<SpendReceipt[]> {
    return (await this.all()).reverse().slice(0, limit);
  }
}
