import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The autofile trust group: a Sovereign-managed Archon group whose members are the Emissaries authorized to
 * BYPASS the ingestion quarantine ("auto-file from this device"). Non-members quarantine born-obsidian and
 * await the Sovereign's triage-confirm. This file holds only the group's DID; membership lives in the group
 * asset (Sovereign-managed via `createRegistryGroup` / `grantAuthorization`), so the trust decision is the
 * SAME signed, group-membership, TRQP-evaluated model KB read/write already uses — not a bespoke flag.
 * Absent group ⇒ nobody is autofile-trusted (the safe default: everything quarantines).
 */
export class AutofileStore {
  private readonly file: string;
  constructor(dataFolder: string) {
    this.file = join(dataFolder, 'autofile.json');
  }
  private read(): { group?: string } {
    try {
      return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as { group?: string }) : {};
    } catch {
      return {};
    }
  }
  /** The autofile group DID, or undefined if none has been provisioned yet. */
  group(): string | undefined {
    return this.read().group;
  }
  /** Persist the provisioned autofile group DID (set once, on first `autofile-grant`). */
  setGroup(group: string): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ group }, null, 2), 'utf8');
  }
}
