/**
 * Warden-minted challenges for the credential-request ceremony (invocation + delegation presentation).
 *
 * The verifier mints the challenge — standard object-capability audience binding. Keymaster's
 * `verifyResponse` verifies the presented credentials (their signatures and challenge-satisfaction), which
 * Hearthold consumes and trusts as a first-class Archon primitive, like Vaults or asset registration. What
 * this store adds is the authorization the reference monitor owns: the presentation must answer a challenge
 * *we* minted, so it is bound to this verifier and this occasion and cannot be replayed as a bearer token.
 * The Warden mints the challenge, remembers it, and the verify path asserts `res.challenge` is one of ours
 * before trusting the disclosed scope — then burns it (single-use) or lets it live to its TTL (reusable).
 *
 * Template: `kb.ts:199-221` (the 18-byte login nonce with a TTL, stored and deleted on use).
 */

import {
  ensureDelegationSchema,
  ensureAuthorizationSchema,
  type KeymasterHandle,
  type ProofRequest,
} from '@hearthold/core';

export type ChallengePurpose = 'invocation' | 'delegation';

interface Live {
  purpose: ChallengePurpose;
  exp: number;
  /** Reusable within its TTL (the long-lived delegation grant) vs single-use (a high-value invocation). */
  reusable: boolean;
}

export class ChallengeStore {
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly warden: KeymasterHandle,
    private readonly registry: string,
    /** The Sovereign trusted to issue invocation scope VCs — required to mint an invocation challenge. */
    private readonly sovereignDid?: string,
    private readonly defaultTtlMs = 120_000,
  ) {}

  private async wardenDid(): Promise<string> {
    const km = this.warden.keymaster;
    const currentId = await km.getCurrentId().catch(() => undefined);
    return currentId ? (await km.resolveDID(currentId)).didDocument?.id ?? '' : '';
  }

  /**
   * Mint the challenge appropriate to `purpose`, selecting the schema + trusted issuer:
   *   - `delegation` — the delegation schema, issued by the Warden itself; **reusable within a 10-min TTL**
   *     (the grant is long-lived and a submission is separately authcrypt-bound, so per-submit freshness would
   *     only cost a mailbox round-trip).
   *   - `invocation` — the authorization schema, issued by the trusted Sovereign; **single-use** (a
   *     high-value evidence disclosure; the act's txn burn already covers the act, this covers the presentation).
   */
  async mintForPurpose(purpose: ChallengePurpose): Promise<string> {
    if (purpose === 'delegation') {
      const wardenDid = await this.wardenDid();
      if (!wardenDid) throw new Error('cannot mint a delegation challenge: warden identity unavailable');
      const schema = await ensureDelegationSchema(this.warden);
      return this.mint('delegation', { schema, trustedIssuers: [wardenDid] }, { reusable: true, ttlMs: 10 * 60_000 });
    }
    if (!this.sovereignDid) throw new Error('cannot mint an invocation challenge: sovereign DID unset');
    const schema = await ensureAuthorizationSchema(this.warden);
    return this.mint('invocation', { schema, trustedIssuers: [this.sovereignDid] }, { reusable: false });
  }

  /**
   * Mint a fresh Warden challenge for `purpose` (schema + trusted issuers per `req`), remembering it so a
   * later response can be bound to it. Born on `registry` (local in dev) — never the default hyperswarm.
   */
  async mint(purpose: ChallengePurpose, req: ProofRequest, opts?: { reusable?: boolean; ttlMs?: number }): Promise<string> {
    const credentials = [
      req.trustedIssuers && req.trustedIssuers.length > 0 ? { schema: req.schema, issuers: req.trustedIssuers } : { schema: req.schema },
    ];
    const challenge = await this.warden.keymaster.createChallenge({ credentials }, { registry: this.registry });
    this.live.set(challenge, { purpose, exp: Date.now() + (opts?.ttlMs ?? this.defaultTtlMs), reusable: opts?.reusable ?? false });
    return challenge;
  }

  /**
   * Assert a response's `challenge` is one WE minted for `purpose` and still fresh. A single-use challenge is
   * burned here (so a captured presentation cannot be replayed); a reusable one lives to its TTL. Fail-closed:
   * an unknown, expired, or wrong-purpose challenge returns false.
   */
  consume(challenge: string, purpose: ChallengePurpose): boolean {
    const e = this.live.get(challenge);
    if (!e) return false;
    const fresh = e.purpose === purpose && Date.now() <= e.exp;
    if (!e.reusable || !fresh) this.live.delete(challenge); // single-use burns on use; an expired reusable is GC'd
    return fresh;
  }

  /** A predicate bound to `purpose`, for passing straight into the verify paths' `requireChallenge`. */
  gate(purpose: ChallengePurpose): (challenge: string) => boolean {
    return (challenge: string) => this.consume(challenge, purpose);
  }
}
