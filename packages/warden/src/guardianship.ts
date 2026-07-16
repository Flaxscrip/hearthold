import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { authorizeGuardianRead, unsealAsWarden, type HearthholdConfig, type KeymasterHandle, type SignedRuleset } from '@hearthold/core';

import { VaultStore } from './store.js';

/**
 * A receipt for a single guardian read — evidence pointed INWARD (guardianship-threat-model.md §4c): the
 * watched member can see the watching. A governor who suppresses receipts has left the protocol.
 */
export interface GuardianReceipt {
  guardian: string;
  subject: string;
  artefactId: string;
  kind: string;
  at: string;
}

/** Append-only store of guardian-read receipts. The member reads `forSubject(theirDid)` to see who read what. */
export class GuardianReceiptStore {
  private readonly file: string;
  constructor(dataFolder: string) {
    this.file = join(dataFolder, 'guardian-receipts.json');
  }
  private async all(): Promise<GuardianReceipt[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as GuardianReceipt[];
    } catch {
      return [];
    }
  }
  async record(r: GuardianReceipt): Promise<void> {
    const a = await this.all();
    a.push(r);
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify(a, null, 2), 'utf8');
  }
  /** Every read performed OVER a member — what that member is entitled to see. */
  async forSubject(subject: string): Promise<GuardianReceipt[]> {
    return (await this.all()).filter((r) => r.subject === subject);
  }
}

/**
 * A governor reads a member's artefact under GUARDIANSHIP. The ladder is satisfied by law, not bypassed:
 * the read is allowed only within an active, member-acknowledged guardianship edge (authorizeGuardianRead
 * runs the chain through operativeRuleset, so an unacknowledged/expired/revoked/forged edge is refused).
 * Every ALLOWED read emits a receipt to the member (the watched sees the watching); a refusal reveals
 * nothing (uniform "not available", no existence leak).
 */
export async function guardianRead(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  chain: SignedRuleset[],
  governor: string,
  subject: string,
  artefactId: string,
  at: string,
): Promise<{ granted: boolean; reason?: string; face?: string }> {
  const artefact = await new VaultStore(handle.dataFolder).get(artefactId);
  if (!artefact || (artefact.owner ?? config.sovereignDid) !== subject) {
    return { granted: false, reason: 'not available' }; // not the subject's, or unknown — uniform refusal
  }
  const authz = await authorizeGuardianRead(handle, chain, {
    governor,
    subject,
    kind: artefact.kind,
    sensitivity: artefact.sensitivity,
    at,
  });
  if (!authz.allowed) return { granted: false, reason: authz.reason };
  // Authorized — receipt the read to the member BEFORE returning the plaintext.
  await new GuardianReceiptStore(handle.dataFolder).record({ guardian: governor, subject, artefactId, kind: artefact.kind, at });
  return { granted: true, face: await unsealAsWarden(handle, artefact.ciphertext) };
}
