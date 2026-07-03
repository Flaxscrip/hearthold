/**
 * `issued` evidence leaves — third-party credentials held in the vault.
 *
 * Archon already supports third-party VCs (an external issuer issues to the Sovereign's DID).
 * Hearthold custodies them as `issued` evidence leaves: the authoritative, externally-trusted
 * provenance the Warden assembles into a proof. The verifier trusts the *original issuer's* DID,
 * not the Warden — so these are the strongest leaves (see docs/evidence-graph.md).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KeymasterHandle } from './keymaster.js';

export interface IssuedLeaf {
  trustClass: 'issued';
  /** DID of the third-party credential. */
  credentialDid: string;
  /** DID of the external issuer (e.g. a guild manager). */
  issuer: string;
  /** DID of the subject — the Sovereign the credential is about. */
  subject: string;
  /** Best-effort credential type (e.g. 'GuildMembership'). */
  credentialType: string;
  /** The credential's schema DID — a verifier requires the leaf by this in a composite challenge. */
  schema?: string;
  /** The credential's claims (subject fields, minus the id). */
  claims: Record<string, unknown>;
  /** Issued credentials are asserted by their external issuer. */
  descriptionSource: 'issuer-asserted';
  /** Status as of acceptance; re-checked against the issuer at prove time. */
  status: 'valid' | 'revoked' | 'unknown';
  validUntil?: string;
  acceptedAt: string;
}

/** File-backed store of `issued` leaves, kept in the Warden's vault folder. */
export class IssuedStore {
  private readonly file: string;

  constructor(private readonly vaultFolder: string) {
    this.file = join(vaultFolder, 'issued.json');
  }

  private async readAll(): Promise<IssuedLeaf[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as IssuedLeaf[];
    } catch {
      return [];
    }
  }

  async put(leaf: IssuedLeaf): Promise<void> {
    await mkdir(this.vaultFolder, { recursive: true });
    const all = (await this.readAll()).filter((l) => l.credentialDid !== leaf.credentialDid);
    all.push(leaf);
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }

  async list(): Promise<IssuedLeaf[]> {
    return this.readAll();
  }

  async get(credentialDid: string): Promise<IssuedLeaf | undefined> {
    return (await this.readAll()).find((l) => l.credentialDid === credentialDid);
  }
}

/**
 * Read an accepted third-party credential (the holder/subject must already hold it) and record it
 * as an `issued` leaf in the vault. Returns the leaf.
 */
export async function recordIssuedCredential(
  handle: KeymasterHandle,
  credentialDid: string,
  vaultFolder: string,
): Promise<IssuedLeaf> {
  const vc = await handle.keymaster.getCredential(credentialDid);
  if (!vc) throw new Error(`credential not held / not resolvable: ${credentialDid}`);

  const subjectFields = { ...(vc.credentialSubject ?? {}) } as Record<string, unknown>;
  const subject = String(subjectFields.id ?? '');
  delete subjectFields.id;

  const specificType = vc.type.find((t) => t !== 'VerifiableCredential');
  const credentialType = String(subjectFields.type ?? specificType ?? 'VerifiableCredential');

  const schema = (vc as { credentialSchema?: { id?: string } }).credentialSchema?.id;

  const leaf: IssuedLeaf = {
    trustClass: 'issued',
    credentialDid,
    issuer: vc.issuer,
    subject,
    credentialType,
    schema,
    claims: subjectFields,
    descriptionSource: 'issuer-asserted',
    status: 'valid',
    validUntil: vc.validUntil,
    acceptedAt: new Date().toISOString(),
  };

  await new IssuedStore(vaultFolder).put(leaf);
  return leaf;
}
