import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  GroupTrustRegistry,
  type KeymasterHandle,
  type HearthholdConfig,
} from '@hearthold/core';

import { KbService } from './kb.js';

/** Persisted KB provisioning for a Warden: which resource, and the read/write authorization groups. */
export interface KbConfig {
  kbId: string;
  readGroup: string;
  writeGroup: string;
}

/**
 * File-backed KB config in the Warden's data folder. One KB per Warden in this increment (the
 * Warden's vault *is* the KB), so this holds a single config.
 */
export class KbConfigStore {
  private readonly file: string;

  constructor(private readonly dataFolder: string) {
    this.file = join(dataFolder, 'hearthold-kb.json');
  }

  async read(): Promise<KbConfig | null> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as KbConfig;
    } catch {
      return null;
    }
  }

  async save(config: KbConfig): Promise<void> {
    await mkdir(this.dataFolder, { recursive: true });
    await writeFile(this.file, JSON.stringify(config, null, 2), 'utf8');
  }
}

/**
 * Build a live `KbService` from the Warden's persisted KB config, or undefined if no KB is provisioned.
 * Used by the daemon (`serve` / `control`) to serve the KB over DIDComm.
 */
export async function buildKbService(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  wardenDid: string,
): Promise<KbService | undefined> {
  const kb = await new KbConfigStore(handle.dataFolder).read();
  if (!kb) return undefined;
  const registry = new GroupTrustRegistry(
    handle,
    [
      { action: 'read', resource: kb.kbId, group: kb.readGroup },
      { action: 'write', resource: kb.kbId, group: kb.writeGroup },
    ],
    wardenDid,
  );
  return new KbService(handle, config, { kbId: kb.kbId, wardenDid, registry });
}
