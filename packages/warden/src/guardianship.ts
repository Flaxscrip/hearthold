import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { authorizeGuardianRead, operativeRuleset, unsealAsWarden, type HearthholdConfig, type KeymasterHandle, type SignedRuleset } from '@hearthold/core';

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

/** The stable key for a governor↔subject guardianship edge (one Ruleset chain per edge). */
const edgeKey = (governor: string, subject: string): string => `${governor}|${subject}`;

/**
 * File-backed store of guardianship Ruleset chains, one append-only chain per governor↔subject edge
 * (guardianship-threat-model §3). The Warden custodies these; each version is governor-signed and — once
 * acknowledged — carries the subject member's ack. The store never signs or verifies (that is the
 * amendment-rule machinery in core/ruleset.ts); it only persists and serves chains.
 */
export class GuardianshipStore {
  private readonly file: string;
  constructor(dataFolder: string) {
    this.file = join(dataFolder, 'guardianships.json');
  }
  private async all(): Promise<Record<string, SignedRuleset[]>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, SignedRuleset[]>;
    } catch {
      return {};
    }
  }
  private async write(all: Record<string, SignedRuleset[]>): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
  /** The current chain for one edge (empty if none). */
  async chain(governor: string, subject: string): Promise<SignedRuleset[]> {
    return (await this.all())[edgeKey(governor, subject)] ?? [];
  }
  /** Append a new version to an edge's chain (grant, acknowledgment attached, or revoke supersession). */
  async append(governor: string, subject: string, version: SignedRuleset): Promise<void> {
    const all = await this.all();
    const key = edgeKey(governor, subject);
    all[key] = [...(all[key] ?? []), version];
    await this.write(all);
  }
  /** Replace an edge's whole chain (e.g. attaching a member ack to the pending head version). */
  async replaceChain(governor: string, subject: string, chain: SignedRuleset[]): Promise<void> {
    const all = await this.all();
    all[edgeKey(governor, subject)] = chain;
    await this.write(all);
  }
  /** Every edge whose subject is this member — what watches THEM (the conspicuous surface). */
  async forSubject(subject: string): Promise<{ governor: string; chain: SignedRuleset[] }[]> {
    const all = await this.all();
    return Object.entries(all)
      .filter(([k]) => k.endsWith(`|${subject}`))
      .map(([k, chain]) => ({ governor: k.slice(0, k.length - subject.length - 1), chain }));
  }
  /** Every edge this governor holds — what THEY watch. */
  async forGovernor(governor: string): Promise<{ subject: string; chain: SignedRuleset[] }[]> {
    const all = await this.all();
    return Object.entries(all)
      .filter(([k]) => k.startsWith(`${governor}|`))
      .map(([k, chain]) => ({ subject: k.slice(governor.length + 1), chain }));
  }
}

/** A conspicuously-rendered view of one active guardianship edge (never covert — threat-model §4b). */
export interface ActiveGuardianship {
  governor: string;
  subject: string;
  kinds?: string[];
  ceiling?: number;
  validUntil?: string;
}

/**
 * The active guardianship edges over a subject member — for the member's own Table/portal "who watches
 * me" surface. Only edges whose operative (member-acknowledged, unrevoked) head is active are returned;
 * an unacknowledged grant or a revoked/emancipated edge shows nothing (it authorizes nothing).
 */
export async function activeGuardianships(
  handle: KeymasterHandle,
  store: GuardianshipStore,
  subject: string,
): Promise<ActiveGuardianship[]> {
  const edges = await store.forSubject(subject);
  const out: ActiveGuardianship[] = [];
  for (const { governor, chain } of edges) {
    const op = await operativeRuleset(handle, chain, { expectedSigner: governor });
    if (op && op.subject === subject && op.actor === governor) {
      out.push({ governor, subject, kinds: op.capabilities?.kinds, ceiling: op.ceiling, validUntil: op.validUntil });
    }
  }
  return out;
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
