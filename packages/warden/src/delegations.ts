import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KeymasterHandle, WitnessKind } from '@hearthold/core';
import { verifyProof, ensureDelegationSchema } from '@hearthold/core';

/**
 * The kinds a legacy delegation (recorded before per-path kind-scoping) is treated as granting — the set the
 * delegate route hardcoded before `kinds` was recorded. Deliberately EXCLUDES `image`/`book`/`link`: an old
 * text delegation must not silently gain the image path (which needs an explicit, separately-revocable grant).
 */
export const LEGACY_DELEGATION_KINDS: WitnessKind[] = ['event', 'location', 'activity', 'browsing', 'document'];

interface DelegationRecord {
  subjectDid: string;
  credentialDid: string;
  issuedAt: string;
  /**
   * The household member (Sovereign) this Emissary submits on behalf of — the OWNER attributed to its
   * submissions. Absent on single-Sovereign delegations (owner then defaults to the configured Sovereign).
   */
  memberDid?: string;
  /**
   * The witness kinds this Emissary is delegated to submit — the compartment boundary. A submission whose
   * `kind` isn't in this set is REFUSED (per-path Emissary isolation). Absent on a legacy record ⇒ treated
   * as `LEGACY_DELEGATION_KINDS` (never `image`).
   */
  kinds?: WitnessKind[];
}

/**
 * Records the delegations the Warden has issued, so it can authorize inbound submissions: a Emissary
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

  /**
   * List the delegations the Warden has issued (subject + credential + the member each serves). Callers
   * that surface this to a session MUST owner-scope by `memberDid` — an Emissary relationship is a
   * cross-member metadata leak otherwise (`memberDid` absent = a single-Sovereign delegation).
   */
  async list(): Promise<{ subjectDid: string; credentialDid: string; memberDid?: string }[]> {
    return (await this.readAll()).map((r) => ({
      subjectDid: r.subjectDid,
      credentialDid: r.credentialDid,
      memberDid: r.memberDid,
    }));
  }

  /** Record a freshly issued delegation. `memberDid` binds the Emissary to a member; `kinds` scopes its path. */
  async record(subjectDid: string, credentialDid: string, memberDid?: string, kinds?: WitnessKind[]): Promise<void> {
    await mkdir(this.warden.dataFolder, { recursive: true });
    const all = await this.readAll();
    all.push({ subjectDid, credentialDid, issuedAt: new Date().toISOString(), memberDid, ...(kinds ? { kinds } : {}) });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }

  /**
   * Authorize a submission by a PRESENTED delegation credential (the VC path, replacing the local ACL). The
   * Emissary answers the Warden's credential-request challenge with its held delegation; `verifyProof` returns
   * the `kinds` + `member` claims, the proven holder (`responder`), and issuer-trust (the Warden signed it) in
   * one step — no `delegations.json` lookup, and the VC's own `validUntil`/revocation apply. Fail-closed.
   */
  async verifyDelegationPresentation(
    presentation: string,
    expectedHolder: string,
  ): Promise<{ ok: true; kinds: WitnessKind[]; member?: string } | { ok: false; reason: string }> {
    if (!presentation) return { ok: false, reason: 'no delegation presentation' };
    const km = this.warden.keymaster;
    const currentId = await km.getCurrentId().catch(() => undefined);
    const wardenDid = currentId ? (await km.resolveDID(currentId)).didDocument?.id ?? '' : '';
    if (!wardenDid) return { ok: false, reason: 'warden identity unavailable' };
    const schema = await ensureDelegationSchema(this.warden);
    const proof = await verifyProof(this.warden, presentation, { trustedIssuers: [wardenDid], schema }).catch(
      (e: unknown) => ({ ok: false as const, disclosed: [], reason: `presentation not verifiable: ${e instanceof Error ? e.message : String(e)}` }),
    );
    if (!proof.ok || !proof.responder) return { ok: false, reason: proof.reason ?? 'delegation presentation not verified' };
    if (proof.responder !== expectedHolder) return { ok: false, reason: 'presenter is not the delegate (holder mismatch)' };
    // Bind the caller to the credential subject — possession of the delegation VC is not authority.
    const subject = proof.disclosed[0]?.subject;
    if (!subject || subject !== proof.responder) return { ok: false, reason: 'presenter does not control the delegation subject' };
    const claims = (proof.disclosed[0]?.claims ?? {}) as { kinds?: WitnessKind[]; member?: string };
    return { ok: true, kinds: claims.kinds ?? LEGACY_DELEGATION_KINDS, member: claims.member };
  }
}
