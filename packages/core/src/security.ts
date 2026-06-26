/**
 * Hearthold security model.
 *
 * Release is governed by two independent ordinal scales — an artefact's SENSITIVITY and a
 * request's AUTHORIZATION tier — plus a DISCLOSURE transform describing what actually leaves
 * the house. See docs/security-model.md.
 */

// ── Sensitivity (per artefact) ────────────────────────────────────────────────

export const Sensitivity = {
  PUBLIC: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  SEALED: 4,
} as const;
export type Sensitivity = (typeof Sensitivity)[keyof typeof Sensitivity];

/** Fail-safe default for anything not yet classified. */
export const DEFAULT_SENSITIVITY: Sensitivity = Sensitivity.SEALED;

/** Relaxing to this level or below requires explicit human confirmation. */
export const HUMAN_CONFIRM_BELOW: Sensitivity = Sensitivity.MEDIUM;

// ── Authorization (per request) ───────────────────────────────────────────────

export const AuthzTier = {
  STANDING: 1,
  CHALLENGE: 2,
  HUMAN: 3,
  MULTIFACTOR: 4,
} as const;
export type AuthzTier = (typeof AuthzTier)[keyof typeof AuthzTier];

/** Maximum sensitivity each authorization tier can clear. PUBLIC is always releasable. */
const CLEARANCE: Record<AuthzTier, Sensitivity> = {
  [AuthzTier.STANDING]: Sensitivity.LOW,
  [AuthzTier.CHALLENGE]: Sensitivity.MEDIUM,
  [AuthzTier.HUMAN]: Sensitivity.HIGH,
  [AuthzTier.MULTIFACTOR]: Sensitivity.SEALED,
};

/** Does this authorization tier clear an artefact at the given sensitivity? */
export function clearsSensitivity(tier: AuthzTier, sensitivity: Sensitivity): boolean {
  if (sensitivity === Sensitivity.PUBLIC) return true;
  return CLEARANCE[tier] >= sensitivity;
}

/** The minimum authorization tier required to release a given sensitivity. */
export function requiredTier(sensitivity: Sensitivity): AuthzTier {
  const tiers: AuthzTier[] = [
    AuthzTier.STANDING,
    AuthzTier.CHALLENGE,
    AuthzTier.HUMAN,
    AuthzTier.MULTIFACTOR,
  ];
  return tiers.find((t) => clearsSensitivity(t, sensitivity)) ?? AuthzTier.MULTIFACTOR;
}

// ── Disclosure (what actually leaves) ─────────────────────────────────────────

export const DisclosureMode = {
  /** A derived VC asserting a fact without the source; provenance carried as content hashes. Default. */
  ATTESTATION: 'ATTESTATION',
  /** Reveal chosen underlying claims against signed salted digests / Merkle membership (SD-JWT-VC style). */
  SELECTIVE: 'SELECTIVE',
  /** Artefact with fields removed. */
  REDACTED: 'REDACTED',
  /** Raw artefact (or a copy). Rare; high tiers only. */
  FULL: 'FULL',
  /** Predicate proof over data the Warden did not issue (e.g. ZK). Optional. */
  PREDICATE: 'PREDICATE',
} as const;
export type DisclosureMode = (typeof DisclosureMode)[keyof typeof DisclosureMode];

// ── Release decision ──────────────────────────────────────────────────────────

export interface ReleaseContext {
  /** Sensitivity of the artefact being requested. */
  sensitivity: Sensitivity;
  /** Authorization tier the request has actually satisfied. */
  tier: AuthzTier;
  /** Whether the presented delegation is valid and unrevoked. */
  delegationValid: boolean;
  /** Disclosure mode requested. */
  mode: DisclosureMode;
  /** Whether the requested disclosure mode can be satisfied for this artefact. */
  disclosureSatisfiable: boolean;
}

export interface ReleaseDecision {
  allow: boolean;
  reason: string;
}

/** Pure release decision. Side effects (audit, mint) are the caller's job. */
export function decideRelease(ctx: ReleaseContext): ReleaseDecision {
  if (ctx.sensitivity === Sensitivity.PUBLIC) {
    return { allow: true, reason: 'public artefact' };
  }
  if (!ctx.delegationValid) {
    return { allow: false, reason: 'no valid/unrevoked delegation' };
  }
  if (!clearsSensitivity(ctx.tier, ctx.sensitivity)) {
    return {
      allow: false,
      reason: `insufficient authorization: tier ${ctx.tier} cannot clear sensitivity ${ctx.sensitivity}`,
    };
  }
  if (!ctx.disclosureSatisfiable) {
    return { allow: false, reason: `cannot satisfy disclosure mode ${ctx.mode}` };
  }
  return { allow: true, reason: 'authorization clears sensitivity' };
}

/** Whether relaxing to a target sensitivity requires human confirmation. */
export function relaxNeedsConfirmation(target: Sensitivity): boolean {
  return target <= HUMAN_CONFIRM_BELOW;
}
