/**
 * The invocation reference monitor — the check EVERY capability invocation crosses at the point of use.
 * Mandatory, per-request, fail-closed. See docs/invocation.md.
 *
 * THE BINDING (sound by construction): the caller presents the Sovereign-issued scope VC via an Archon
 * credential-request challenge/response, and `verifyProof` returns the disclosed scope, the responder (the
 * proven holder), and issuer-trust in one step. The monitor enforces the act against THAT verified scope —
 * there is no wire capability body to forge, and no bespoke chain/disclosure to get wrong. This is the same
 * primitive `prove.ts` uses for evidence, applied to authorization.
 *
 * Prior art (docs/attributions.md): Karp (reference monitor / designation ≡ authority; authorization ≠
 * credential), Macaroons (the discharge bound to the request), ZCAP-LD (invocation checked against the cap).
 */

import type { KeymasterHandle } from './keymaster.js';
import type { AuthoritySet } from './attenuation.js';
import type { CapabilityInvocation, Caveats, ThirdPartyCaveat } from './capability.js';
import { AUTHORIZATION_TYPE, targetWithin } from './capability.js';
import { verifyProof } from './prove.js';
import type { SpentTxnStore } from './single-use.js';
import { StatusListResolver } from './status-list.js';
import type { Sensitivity } from './security.js';

export interface InvocationContext {
  /** Any keymaster bound to the Gatekeeper the Warden trusts (verifies the presentation). */
  keymaster: KeymasterHandle;
  /** The Sovereign trusted to issue scope capabilities — the presentation's credential must be from it. */
  expectedRootIssuer: string;
  /** The HearthholdAuthorization schema DID the challenge requested (from `ensureAuthorizationSchema`). */
  authorizationSchema: string;
  /** Single-use ledger — the act's txn is burned on success so the invocation cannot be replayed. */
  spent: SpentTxnStore;
  /** Sensitivity of what the act would disclose (the Warden computes it post-assembly; ≤ the bound ceiling). */
  sensitivity?: Sensitivity;
  /**
   * WARDEN POLICY human gate (audit-3 §3): disclosures at or above this sensitivity REQUIRE the owner's fresh
   * signed consent (a discharge), regardless of whether the issuer attached a `requiresDischarge` caveat. This
   * is what stops a `ceiling: SEALED` capability with no caveat from disclosing SEALED with no human in the
   * loop. Undefined ⇒ no policy gate (only issuer-attached caveats apply).
   */
  requiresHumanAt?: Sensitivity;
  /** The resolved owner whose Signet the policy consent routes to (evidence.ts resolves the caveat/fallback). */
  owner?: string;
  /** Transport-authenticated caller (authcrypt sender), when available — an additional binding to the holder. */
  fromDid?: string;
  /**
   * Assert the presentation answered a challenge WE minted (and burn it). Without this a presentation is a
   * permanent bearer token — audit-3 §1. The Warden passes `ChallengeStore.gate('invocation')`; a caller that
   * omits it (a direct-library test) skips the check, but the daemon path always supplies it.
   */
  requireChallenge?: (challenge: string) => boolean;
  /** Max-age for the StatusList cache (default: fresh resolve every invocation). */
  statusMaxAgeMs?: number;
}

/** The capability as VERIFIED from the presentation — the only thing the monitor enforces against. */
export interface VerifiedLeaf {
  id: string;
  holder: string;
  authority: AuthoritySet;
  caveats: Caveats;
}

export interface InvocationDecision {
  allow: boolean;
  reason: string;
  owner?: string;
  audience?: string;
  ceiling?: Sensitivity;
  /** allow:false WITH this set ⇒ a consent gap, not a denial: obtain these discharges and retry. */
  needsDischarge?: { by: string; predicate: string }[];
}

const deny = (reason: string): InvocationDecision => ({ allow: false, reason });

/** The predicate the Warden's sensitivity policy asks the owner's Signet to sign — a fresh human consent. */
export const POLICY_CONSENT_PREDICATE = 'human-consent' as const;

/**
 * Resolve + AUTHENTICATE the invocation, returning the VERIFIED capability. Verifies the presentation
 * (issuer-trusted scope VC + holder control), then checks the act ⊆ authority and the fail-closed revocation
 * status. Everything is read from the verified presentation — never a wire body. Deny on first failure.
 */
export async function resolveInvocation(
  inv: CapabilityInvocation,
  ctx: InvocationContext,
): Promise<{ ok: true; leaf: VerifiedLeaf } | { ok: false; reason: string }> {
  if (!inv.presentation) return { ok: false, reason: 'invocation carries no capability presentation' };
  if (!ctx.expectedRootIssuer) return { ok: false, reason: 'no trusted root issuer configured (Sovereign DID unset)' };

  // The Archon credential-request ceremony: the presentation must satisfy the challenge (schema = the
  // authorization schema) AND be issued by the trusted Sovereign. `verifyProof` returns the disclosed scope,
  // the responder (proven holder control), and enforces issuer-trust.
  const proof = await verifyProof(ctx.keymaster, inv.presentation, {
    trustedIssuers: [ctx.expectedRootIssuer],
    schema: ctx.authorizationSchema,
  }).catch((e: unknown) => ({ ok: false as const, challenge: '', disclosed: [], reason: `not verifiable: ${e instanceof Error ? e.message : String(e)}` }));
  if (!proof.ok) return { ok: false, reason: `capability presentation invalid: ${proof.reason ?? 'not verified'}` };
  if (!proof.responder) return { ok: false, reason: 'presentation has no responder (holder not proven)' };
  // Freshness / audience binding: the presentation must answer a challenge WE minted (single-use, TTL-bound),
  // not a self-minted or captured one. Burns the challenge. Fail-closed when a gate is configured.
  if (ctx.requireChallenge && !ctx.requireChallenge(proof.challenge)) {
    return { ok: false, reason: 'presentation did not answer a fresh Warden-minted challenge' };
  }

  const authCred = proof.disclosed.find((d) => (d.claims as { type?: string }).type === AUTHORIZATION_TYPE) ?? proof.disclosed[0];
  if (!authCred) return { ok: false, reason: 'no authorization credential presented' };
  const claims = authCred.claims as { authority?: AuthoritySet; caveats?: Caveats };
  if (!claims.authority || !Array.isArray(claims.authority.operations) || !claims.caveats) {
    return { ok: false, reason: 'authorization credential is missing authority/caveats' };
  }
  // Bind the caller to the credential SUBJECT the Sovereign signed — possession of the VC plaintext (a copied
  // wallet, a shared data root) is NOT authority. The subject must be the party that produced the response.
  if (!authCred.subject || authCred.subject !== proof.responder) return { ok: false, reason: 'presenter does not control the credential subject' };
  const holder = proof.responder;
  if (ctx.fromDid && ctx.fromDid !== holder) return { ok: false, reason: 'transport sender is not the capability holder' };

  const leaf: VerifiedLeaf = { id: authCred.credentialDid, holder, authority: claims.authority, caveats: claims.caveats };

  // The ACT must sit within the verified authority (designation is authority — no ambient lookup, no wire).
  if (!leaf.authority.operations.includes(inv.act.action)) return { ok: false, reason: `action '${inv.act.action}' is not in the capability's operations` };
  const targetOk = leaf.authority.resources.some((r) => inv.act.target === r || targetWithin(inv.act.target, r));
  if (!targetOk) return { ok: false, reason: `target '${inv.act.target}' is outside the capability's resources` };

  // Revocation — from the capability's own status pointer. Fail-closed.
  const status = leaf.caveats.status;
  if (status) {
    const resolver = new StatusListResolver(ctx.keymaster, {
      statusListCredential: status.statusListCredential,
      expectedIssuer: ctx.expectedRootIssuer,
      maxAgeMs: ctx.statusMaxAgeMs ?? 30_000,
    });
    const s = await resolver.check(status.statusListIndex);
    if (!s.available) return { ok: false, reason: `revocation status unavailable — ${s.reason ?? 'fail-closed'}` };
    if (s.revoked) return { ok: false, reason: 'capability is revoked' };
  }

  return { ok: true, leaf };
}

/**
 * Authorize the act against an already-resolved leaf: replay, ceiling, consent discharge. Burns the txn on
 * success. Split from resolve so the caller can assemble the owner-scoped evidence (→ sensitivity) in between.
 */
export async function authorizeInvocation(inv: CapabilityInvocation, ctx: InvocationContext, leaf: VerifiedLeaf): Promise<InvocationDecision> {
  if (await ctx.spent.isSpent(inv.act.txn)) return deny('invocation txn already spent (replay)');

  // Capability lifetime enforced at USE, not just narrowed at issuance: expiry + single-use burn of the cap.
  if (leaf.caveats.expires) {
    const exp = Date.parse(leaf.caveats.expires);
    if (Number.isNaN(exp) || exp <= Date.now()) return deny('capability has expired');
  }
  if (leaf.caveats.singleUse && (await ctx.spent.isSpent(`cap:${leaf.id}`))) return deny('single-use capability already spent');

  if (ctx.sensitivity !== undefined && ctx.sensitivity > leaf.caveats.ceiling) {
    return deny(`sensitivity ${ctx.sensitivity} exceeds the capability ceiling ${leaf.caveats.ceiling}`);
  }

  const unmet: { by: string; predicate: string }[] = [];
  for (const cav of leaf.caveats.requiresDischarge ?? []) {
    if (!(await hasValidDischarge(inv, cav, ctx))) unmet.push({ by: cav.by, predicate: cav.predicate });
  }
  // Warden POLICY gate: a disclosure at/above `requiresHumanAt` needs the OWNER's fresh consent even if the
  // issuer attached no caveat — so a `ceiling: SEALED` capability cannot disclose SEALED with no human (§3).
  if (
    ctx.requiresHumanAt !== undefined &&
    ctx.sensitivity !== undefined &&
    ctx.sensitivity >= ctx.requiresHumanAt
  ) {
    const owner = leaf.caveats.owner ?? ctx.owner;
    if (!owner) return deny('policy requires the owner’s consent for this sensitivity, but the capability names no owner');
    const policyCav: ThirdPartyCaveat = { by: owner, predicate: POLICY_CONSENT_PREDICATE };
    const already = unmet.some((u) => u.by === owner && u.predicate === POLICY_CONSENT_PREDICATE);
    if (!already && !(await hasValidDischarge(inv, policyCav, ctx))) unmet.push({ by: owner, predicate: POLICY_CONSENT_PREDICATE });
  }
  if (unmet.length > 0) return { allow: false, reason: 'discharge required', needsDischarge: unmet, owner: leaf.caveats.owner ?? ctx.owner, ceiling: leaf.caveats.ceiling };

  await ctx.spent.markSpent(inv.act.txn);
  if (leaf.caveats.singleUse) await ctx.spent.markSpent(`cap:${leaf.id}`);
  return { allow: true, reason: 'invocation authorized', owner: leaf.caveats.owner, audience: leaf.caveats.audience, ceiling: leaf.caveats.ceiling };
}

/** Convenience: resolve + authorize in one call (for direct callers / tests). */
export async function verifyInvocation(inv: CapabilityInvocation, ctx: InvocationContext): Promise<InvocationDecision> {
  const r = await resolveInvocation(inv, ctx);
  if (!r.ok) return deny(r.reason);
  return authorizeInvocation(inv, ctx, r.leaf);
}

/**
 * A discharge satisfies a third-party caveat iff it is signed by the DESIGNATED party (`cav.by`), covers the
 * same `predicate`, and is bound to THIS invocation's `txn` (the macaroon PrepareForRequest binding — so a
 * discharge for one act/predicate cannot be replayed against another). The approver is named by the caveat.
 */
async function hasValidDischarge(inv: CapabilityInvocation, cav: ThirdPartyCaveat, ctx: InvocationContext): Promise<boolean> {
  const verifyProofFn = ctx.keymaster.keymaster.verifyProof.bind(ctx.keymaster.keymaster) as (o: unknown) => Promise<boolean>;
  for (const d of inv.discharges ?? []) {
    if (d.by !== cav.by || d.txn !== inv.act.txn || d.predicate !== cav.predicate || !d.proof) continue;
    if (!(await verifyProofFn(d).catch(() => false))) continue;
    const signer = ((d.proof as { verificationMethod?: string }).verificationMethod ?? '').split('#')[0];
    if (signer === cav.by) return true;
  }
  return false;
}

/**
 * What the Warden sends a DESIGNATED Signet to obtain a consent discharge. The Warden authors this text (the
 * requester's words are never shown to the human); the discharge that comes back is bound to `txn`.
 */
export interface DischargeRequest {
  /** The act's txn the discharge must be bound to (anti-replay across acts). */
  txn: string;
  /** The party expected to sign — equals the caveat's `by` (the owner's Signet). */
  by: string;
  predicate: string;
  claim?: string;
  reason?: string;
  sensitivity?: Sensitivity;
}
