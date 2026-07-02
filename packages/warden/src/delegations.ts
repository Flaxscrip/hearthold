import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KeymasterHandle } from '@hearthold/core';

interface DelegationRecord {
  subjectDid: string;
  credentialDid: string;
  issuedAt: string;
}

/**
 * Records the delegations the Warden has issued, so it can authorize inbound submissions: a Witness
 * DID is authorized iff the Warden issued it a delegation that is still valid (not revoked).
 *
 * Authentication is handled by the transport (DIDComm authcrypt proves the sender DID); this is the
 * authorization check on top of it.
 */
export class DelegationStore {
  private readonly file: string;

  constructor(private readonly warden: KeymasterHandle) {
    this.file = join(warden.dataFolder, 'delegations.json');
  }

  private async readAll(): Promise<DelegationRecord[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as DelegationRecord[];
    } catch {
      return [];
    }
  }

  /** List the delegations the Warden has issued (subject + credential). */
  async list(): Promise<{ subjectDid: string; credentialDid: string }[]> {
    return (await this.readAll()).map((r) => ({
      subjectDid: r.subjectDid,
      credentialDid: r.credentialDid,
    }));
  }

  /** Record a freshly issued delegation. */
  async record(subjectDid: string, credentialDid: string): Promise<void> {
    await mkdir(this.warden.dataFolder, { recursive: true });
    const all = await this.readAll();
    all.push({ subjectDid, credentialDid, issuedAt: new Date().toISOString() });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }

  /** Authorized iff we issued this DID a delegation whose credential still resolves (not revoked). */
  async isAuthorized(subjectDid: string): Promise<boolean> {
    const rec = (await this.readAll()).find((r) => r.subjectDid === subjectDid);
    if (!rec) return false;
    const vc = await this.warden.keymaster.getCredential(rec.credentialDid).catch(() => null);
    return vc != null;
  }
}
