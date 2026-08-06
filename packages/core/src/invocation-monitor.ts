/**
 * The invocation reference monitor — the check EVERY capability invocation crosses at the point of use.
 * Generalizes the mesh admit monitor (mesh.ts): mandatory, per-request, fail-closed. See docs/invocation.md.
 *
 * THE BINDING RULE (the fix for the second audit's central defect): every enforced value is read from the
 * VERIFIED, commitment-bound chain — never from `inv.capability.credentialSubject`, which is an
 * unauthenticated wire object. `verifyCapabilityChain(requireFullDisclosure)` returns the leaf's holder
 * (issuer-attested) and its commitment-bound authority + caveats; the monitor enforces THOSE. The caller is
 * bound to the leaf's holder by Archon challenge/response (`verifyResponse`), not by a self-asserted
 * `controller`. Owner, ceiling, audience, revocation status and consent obligations all come from the bound
 * caveats, so none is forgeable and none is skippable by omission.
 *
 * Prior art (docs/attributions.md): Karp (reference monitor / designation ≡ authority), Macaroons (the
 * discharge bound to the request), ZCAP-LD (invocation checked against the capability).
 */

import type { KeymasterHandle } from './keymaster.js';
import type { AuthoritySet, AuthoritySetPayload } from './attenuation.js';
import type { CapabilityInvocation, Caveats, ThirdPartyCaveat } from './capability.js';
import { isAuthorizationCredential, targetWithin } from './capability.js';
import { verifyCapabilityChain } from './capability-chain.js';
import type { SpentTxnStore } from './single-use.js';
import { StatusListResolver } from './status-list.js';
import type { Sensitivity } from './security.js';

export interface InvocationContext {
  /** Any keymaster bound to the Gatekeeper the Warden trusts (resolves + verifies the capability chain). */
  keymaster: KeymasterHandle;
  /** Pin the root of trust — the Sovereign whose root capability anchors the chain, and the status-list issuer. */
  expectedRootIssuer: string;
  /** The presented chain disclosure ({authoritySet, salt, caveats} per hop DID). MUST cover every hop —
   *  it is what binds the chain to its commitments and reveals what the leaf actually grants. */
  disclosed: Record<string, AuthoritySetPayload>;
  /** Single-use ledger — the act's txn is burned on success so the invocation cannot be replayed. */
  spent: SpentTxnStore;
  /** Sensitivity of what the act would disclose (the Warden computes it post-assembly; ≤ the bound ceiling). */
  sensitivity?: Sensitivity;
  /** Transport-authenticated caller (authcrypt sender), when available — an additional binding to the holder. */
  fromDid?: string;
  /** Max-age for the StatusList cache (default: fresh resolve every invocation). */
  statusMaxAgeMs?: number;
}

/** The leaf as VERIFIED from the chain — the only thing the monitor enforces against. */
export interface VerifiedLeaf {
  id: string;
  holder: string;
  authority: AuthoritySet;
  caveats: Caveats;
}

export interface InvocationDecision {
  allow: boolean;
  reason: string;
  /** On allow: the owner scope the caller MUST enforce (from the bound caveats, not the request). */
  owner?: string;
  /** On allow: the recipient the scroll binds to (bound caveats' audience, else the holder). */
  audience?: string;
  /** The bound ceiling, so the caller can check an assembled sensitivity against it. */
  ceiling?: Sensitivity;
  /** allow:false WITH this set ⇒ a consent gap, not a denial: obtain these discharges and retry. */
  needsDischarge?: { by: string; predicate: string }[];
}

const deny = (reason: string): InvocationDecision => ({ allow: false, reason });

/**
 * Resolve + AUTHENTICATE a capability invocation, returning the VERIFIED leaf. Does everything that does not
 * need the assembled sensitivity: the well-typed check, the full commitment-bound chain, the holder proof,
 * the act ⊆ bound-authority check, and the fail-closed revocation check. Deny on the first failure.
 */
export async function resolveInvocation(
  inv: CapabilityInvocation,
  ctx: InvocationContext,
): Promise<{ ok: true; leaf: VerifiedLeaf } | { ok: false; reason: string }> {
  // 0. Karp's type guard — an authorization is not a credential.
  if (!isAuthorizationCredential(inv.capability)) return { ok: false, reason: 'capability is not typed as an authorization' };
  const claimedId = inv.capability.credentialSubject?.id;
  if (typeof claimedId !== 'string' || !claimedId) return { ok: false, reason: 'capability has no id' };

  // 1. The chain — commitment-bound, every hop disclosed, caveats narrowing enforced in-chain. Returns the
  //    issuer-attested holder and the leaf's bound authority + caveats. Nothing here trusts the wire body.
  const chain = await verifyCapabilityChain(claimedId, {
    keymaster: ctx.keymaster,
    expectedRootIssuer: ctx.expectedRootIssuer,
    disclosed: ctx.disclosed,
    requireFullDisclosure: true,
  });
  if (!chain.ok) return { ok: false, reason: `capability chain invalid: ${[chain.check, chain.reason].filter(Boolean).join(' ')}`.trim() };
  if (!chain.holder || !chain.leafAuthoritySet || chain.leafCaveats === undefined) {
    return { ok: false, reason: 'chain did not yield a bound leaf (holder / authority / caveats)' };
  }
  const leaf: VerifiedLeaf = { id: claimedId, holder: chain.holder, authority: chain.leafAuthoritySet, caveats: chain.leafCaveats as Caveats };

  // 2. Holder binding — the caller must PROVE control of the chain's holder DID (Archon challenge/response),
  //    not self-assert `controller`. Optionally cross-check the authenticated transport sender.
  if (!inv.holderProof) return { ok: false, reason: 'missing holder proof (challenge/response over the holder DID)' };
  const verifyResponse = ctx.keymaster.keymaster.verifyResponse.bind(ctx.keymaster.keymaster) as (r: string) => Promise<{ match?: boolean; responder?: string }>;
  const vr = await verifyResponse(inv.holderProof).catch(() => ({ match: false } as { match?: boolean; responder?: string }));
  if (!vr.match || vr.responder !== leaf.holder) return { ok: false, reason: 'holder control not proven for this capability' };
  if (ctx.fromDid && ctx.fromDid !== leaf.holder) return { ok: false, reason: 'transport sender is not the capability holder' };

  // 3. The ACT must sit within the BOUND authority (designation is authority — no ambient lookup, no wire).
  if (!leaf.authority.operations.includes(inv.act.action)) return { ok: false, reason: `action '${inv.act.action}' is not in the capability's operations` };
  const targetOk = leaf.authority.resources.some((r) => inv.act.target === r || targetWithin(inv.act.target, r));
  if (!targetOk) return { ok: false, reason: `target '${inv.act.target}' is outside the capability's resources` };

  // 4. Revocation — from the BOUND status pointer (cannot be stripped). Fail-closed.
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

  if (ctx.sensitivity !== undefined && ctx.sensitivity > leaf.caveats.ceiling) {
    return deny(`sensitivity ${ctx.sensitivity} exceeds the capability ceiling ${leaf.caveats.ceiling}`);
  }

  const unmet: { by: string; predicate: string }[] = [];
  for (const cav of leaf.caveats.requiresDischarge ?? []) {
    if (!(await hasValidDischarge(inv, cav, ctx))) unmet.push({ by: cav.by, predicate: cav.predicate });
  }
  if (unmet.length > 0) return { allow: false, reason: 'discharge required', needsDischarge: unmet, owner: leaf.caveats.owner, ceiling: leaf.caveats.ceiling };

  await ctx.spent.markSpent(inv.act.txn);
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
  const verifyProof = ctx.keymaster.keymaster.verifyProof.bind(ctx.keymaster.keymaster) as (o: unknown) => Promise<boolean>;
  for (const d of inv.discharges ?? []) {
    if (d.by !== cav.by || d.txn !== inv.act.txn || d.predicate !== cav.predicate || !d.proof) continue;
    if (!(await verifyProof(d).catch(() => false))) continue;
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
