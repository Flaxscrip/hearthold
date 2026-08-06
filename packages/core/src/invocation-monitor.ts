/**
 * The invocation reference monitor — the check EVERY capability invocation crosses at the point of use.
 * Generalizes the mesh admit monitor (mesh.ts) to arbitrary acts: mandatory, per-request, fail-closed.
 * See docs/invocation.md §5.3.
 *
 * It composes verifyCapabilityChain (attenuation + caveat narrowing), single-use (txn burn), and the
 * StatusList resolver (revocation), and enforces that the ACT sits within the leaf capability's authority
 * and caveats. Designation is authority: the owner scope and the approver are read from the CAPABILITY,
 * never from the request — which is what structurally closes the confused-deputy step-up (finding A).
 *
 * Prior art (docs/attributions.md): Karp (reference monitor / designation ≡ authority), Macaroons (the
 * discharge bound to the request — `PrepareForRequest`), ZCAP-LD (invocation checked against the capability).
 */

import type { KeymasterHandle } from './keymaster.js';
import type { AuthoritySetPayload } from './attenuation.js';
import type { CapabilityInvocation, Caveats, ThirdPartyCaveat } from './capability.js';
import { targetWithin } from './capability.js';
import { verifyCapabilityChain } from './capability-chain.js';
import type { SpentTxnStore } from './single-use.js';
import type { StatusListResolver } from './status-list.js';
import type { Sensitivity } from './security.js';

export interface InvocationContext {
  /** Any keymaster bound to the Gatekeeper the Warden trusts (resolves + verifies the capability chain). */
  keymaster: KeymasterHandle;
  /** The DID the transport authenticated as the caller (authcrypt sender). MUST equal the leaf controller. */
  fromDid: string;
  /** Pin the root of trust — the Sovereign whose root capability anchors the chain. */
  expectedRootIssuer: string;
  /**
   * Disclosed {authoritySet, salt, caveats} per hop DID — the leaf revealed by the holder, ancestors known
   * to the Warden (the root is its own anchor) or threaded at delegation. Binds the chain to its commitments
   * and enables the ⊆ + caveat-narrowing checks.
   */
  disclosed: Record<string, AuthoritySetPayload>;
  /** The disclosed caveats, ordered leaf→root, for the caveat-narrowing pass. */
  orderedCaveats: Caveats[];
  /** Single-use ledger — the act's txn is burned on success so the invocation cannot be replayed. */
  spent: SpentTxnStore;
  /** Sensitivity of what the act would disclose (the Warden computes it; must be ≤ the caveat ceiling). */
  sensitivity?: Sensitivity;
  /** Optional revocation check: a resolver plus the leaf capability's status-list index. */
  status?: { resolver: StatusListResolver; index: number };
}

export interface InvocationDecision {
  allow: boolean;
  reason: string;
  /** On allow: the owner scope the caller MUST enforce downstream (from the capability, not the request). */
  owner?: string;
  /** allow:false WITH this set ⇒ not a policy denial but a consent gap: obtain these discharges and retry. */
  needsDischarge?: { by: string; predicate: string }[];
}

const deny = (reason: string): InvocationDecision => ({ allow: false, reason });

/**
 * Verify an invocation. Deny on the FIRST failure. On success the txn is burned and the owner scope is
 * returned. When a caveat requires consent that isn't yet discharged, returns allow:false with
 * `needsDischarge` (the caller escalates to the designated Signet, then retries) — distinct from a denial.
 */
export async function verifyInvocation(inv: CapabilityInvocation, ctx: InvocationContext): Promise<InvocationDecision> {
  const leaf = inv.capability.credentialSubject;

  // 1. Holder binding: the authenticated caller must be the leaf capability's controller.
  if (leaf.controller !== ctx.fromDid) {
    return deny(`caller ${ctx.fromDid.slice(0, 24)}… is not the capability holder`);
  }

  // 2. Replay: the act's txn must not already be spent.
  if (await ctx.spent.isSpent(inv.act.txn)) return deny('invocation txn already spent (replay)');

  // 3. The capability chain: attenuation (authority ⊆), caveat narrowing, signatures, lineage, pinning.
  const chain = await verifyCapabilityChain(leaf.id, {
    keymaster: ctx.keymaster,
    expectedRootIssuer: ctx.expectedRootIssuer,
    disclosed: ctx.disclosed,
    orderedCaveats: ctx.orderedCaveats,
  });
  if (!chain.ok) return deny(`capability chain invalid: ${[chain.check, chain.reason].filter(Boolean).join(' ')}`.trim());

  // 4. The ACT must sit within the leaf's authority (designation is authority — no ambient lookup).
  if (!leaf.authority.operations.includes(inv.act.action)) {
    return deny(`action '${inv.act.action}' is not in the capability's operations`);
  }
  const targetOk = leaf.authority.resources.includes(inv.act.target) || targetWithin(inv.act.target, leaf.invocationTarget);
  if (!targetOk) return deny(`target '${inv.act.target}' is outside the capability's resources/invocationTarget`);

  // 5. Sensitivity ceiling: what the act discloses must clear the caveat ceiling (numeric Sensitivity).
  if (ctx.sensitivity !== undefined && ctx.sensitivity > leaf.caveats.ceiling) {
    return deny(`sensitivity ${ctx.sensitivity} exceeds the capability ceiling ${leaf.caveats.ceiling}`);
  }

  // 6. Revocation: fail-closed when a status list is configured for this capability.
  if (ctx.status) {
    const s = await ctx.status.resolver.check(ctx.status.index);
    if (!s.available) return deny(`revocation status unavailable — ${s.reason ?? 'fail-closed'}`);
    if (s.revoked) return deny('capability is revoked');
  }

  // 7. Consent obligations: every requiresDischarge caveat must be met by a bound, valid discharge.
  const unmet: { by: string; predicate: string }[] = [];
  for (const cav of leaf.caveats.requiresDischarge ?? []) {
    if (!(await hasValidDischarge(inv, cav, ctx))) unmet.push({ by: cav.by, predicate: cav.predicate });
  }
  if (unmet.length > 0) {
    return { allow: false, reason: 'discharge required', needsDischarge: unmet, owner: leaf.caveats.owner };
  }

  // Success — burn the txn (single-use) and hand back the owner scope the caller must enforce.
  await ctx.spent.markSpent(inv.act.txn);
  return { allow: true, reason: 'invocation authorized', owner: leaf.caveats.owner };
}

/**
 * A discharge satisfies a third-party caveat iff it is signed by the DESIGNATED party (`cav.by`), and is
 * bound to THIS invocation's `txn` (the macaroon PrepareForRequest binding — so a discharge captured for one
 * act cannot be replayed against another). The approver is named by the caveat, never by the requester.
 */
async function hasValidDischarge(inv: CapabilityInvocation, cav: ThirdPartyCaveat, ctx: InvocationContext): Promise<boolean> {
  const verifyProof = ctx.keymaster.keymaster.verifyProof.bind(ctx.keymaster.keymaster) as (o: unknown) => Promise<boolean>;
  for (const d of inv.discharges ?? []) {
    if (d.by !== cav.by || d.txn !== inv.act.txn || !d.proof) continue;
    if (!(await verifyProof(d).catch(() => false))) continue;
    const signer = ((d.proof as { verificationMethod?: string }).verificationMethod ?? '').split('#')[0];
    if (signer === cav.by) return true;
  }
  return false;
}
