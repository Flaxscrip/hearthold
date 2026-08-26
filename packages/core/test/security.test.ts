/**
 * Unit tests for the release ladder — the disclosure security boundary.
 *
 * `decideRelease` and the clearance ladder are the gate every disclosure crosses; per the Architect's
 * review (2026-08-26) they warrant tests that run WITHOUT a live Archon node or Ollama — the situation
 * you most need them in. These import the pure functions directly from source and run via
 * `node --experimental-strip-types --test`; no build, no node, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Sensitivity,
  AuthzTier,
  DisclosureMode,
  clearsSensitivity,
  clearanceCeiling,
  requiredTier,
  decideRelease,
  type ReleaseContext,
} from '../src/security.ts';

test('clearsSensitivity: the tier→sensitivity ladder holds at every rung', () => {
  // STANDING clears ≤ LOW, CHALLENGE ≤ MEDIUM, HUMAN ≤ HIGH, MULTIFACTOR ≤ SEALED.
  assert.equal(clearsSensitivity(AuthzTier.STANDING, Sensitivity.LOW), true);
  assert.equal(clearsSensitivity(AuthzTier.STANDING, Sensitivity.MEDIUM), false);
  assert.equal(clearsSensitivity(AuthzTier.CHALLENGE, Sensitivity.MEDIUM), true);
  assert.equal(clearsSensitivity(AuthzTier.CHALLENGE, Sensitivity.HIGH), false);
  assert.equal(clearsSensitivity(AuthzTier.HUMAN, Sensitivity.HIGH), true);
  assert.equal(clearsSensitivity(AuthzTier.HUMAN, Sensitivity.SEALED), false);
  assert.equal(clearsSensitivity(AuthzTier.MULTIFACTOR, Sensitivity.SEALED), true);
});

test('clearsSensitivity: PUBLIC is always releasable, at every tier', () => {
  for (const tier of Object.values(AuthzTier)) {
    assert.equal(clearsSensitivity(tier, Sensitivity.PUBLIC), true, `tier ${tier} must clear PUBLIC`);
  }
});

test('clearanceCeiling: each tier caps aggregate disclosure at its own ceiling', () => {
  assert.equal(clearanceCeiling(AuthzTier.STANDING), Sensitivity.LOW);
  assert.equal(clearanceCeiling(AuthzTier.CHALLENGE), Sensitivity.MEDIUM);
  assert.equal(clearanceCeiling(AuthzTier.HUMAN), Sensitivity.HIGH);
  assert.equal(clearanceCeiling(AuthzTier.MULTIFACTOR), Sensitivity.SEALED);
});

test('requiredTier: the MINIMUM tier for each sensitivity (SEALED needs MULTIFACTOR)', () => {
  assert.equal(requiredTier(Sensitivity.PUBLIC), AuthzTier.STANDING);
  assert.equal(requiredTier(Sensitivity.LOW), AuthzTier.STANDING);
  assert.equal(requiredTier(Sensitivity.MEDIUM), AuthzTier.CHALLENGE);
  assert.equal(requiredTier(Sensitivity.HIGH), AuthzTier.HUMAN);
  assert.equal(requiredTier(Sensitivity.SEALED), AuthzTier.MULTIFACTOR);
});

test('requiredTier ∘ clearsSensitivity is self-consistent — the required tier always clears', () => {
  for (const s of Object.values(Sensitivity)) {
    assert.equal(clearsSensitivity(requiredTier(s), s), true, `requiredTier(${s}) must clear ${s}`);
  }
});

// ── decideRelease — every branch of the gate ────────────────────────────────────────────────────────────

const ctx = (over: Partial<ReleaseContext>): ReleaseContext => ({
  sensitivity: Sensitivity.MEDIUM,
  tier: AuthzTier.CHALLENGE,
  delegationValid: true,
  mode: DisclosureMode.ATTESTATION,
  disclosureSatisfiable: true,
  ...over,
});

test('decideRelease: a PUBLIC artefact is released before any other check (even with no delegation)', () => {
  const d = decideRelease(ctx({ sensitivity: Sensitivity.PUBLIC, delegationValid: false, tier: AuthzTier.STANDING }));
  assert.equal(d.allow, true);
});

test('decideRelease: an invalid/revoked delegation denies, regardless of tier', () => {
  const d = decideRelease(ctx({ delegationValid: false, tier: AuthzTier.MULTIFACTOR, sensitivity: Sensitivity.LOW }));
  assert.equal(d.allow, false);
  assert.match(d.reason, /delegation/);
});

test('decideRelease: an insufficient tier denies (CHALLENGE cannot clear SEALED)', () => {
  const d = decideRelease(ctx({ sensitivity: Sensitivity.SEALED, tier: AuthzTier.CHALLENGE }));
  assert.equal(d.allow, false);
  assert.match(d.reason, /insufficient authorization/);
});

test('decideRelease: an unsatisfiable disclosure mode denies even when the tier clears', () => {
  const d = decideRelease(ctx({ sensitivity: Sensitivity.MEDIUM, tier: AuthzTier.MULTIFACTOR, disclosureSatisfiable: false, mode: DisclosureMode.SELECTIVE }));
  assert.equal(d.allow, false);
  assert.match(d.reason, /disclosure mode/);
});

test('decideRelease: allows when delegation is valid, the tier clears, and the mode is satisfiable', () => {
  const d = decideRelease(ctx({ sensitivity: Sensitivity.HIGH, tier: AuthzTier.HUMAN }));
  assert.equal(d.allow, true);
});

test('decideRelease: deny-by-default order — the delegation check precedes the tier check', () => {
  // Both fail; the reason must name the delegation (checked first), so a revoked cap never even reaches the
  // tier comparison. Guards the ordering that makes revocation the outermost gate.
  const d = decideRelease(ctx({ delegationValid: false, sensitivity: Sensitivity.SEALED, tier: AuthzTier.STANDING }));
  assert.equal(d.allow, false);
  assert.match(d.reason, /delegation/);
});

test('decideRelease: the FULL disclosure mode is still tier-gated (SEALED needs MULTIFACTOR)', () => {
  const denied = decideRelease(ctx({ sensitivity: Sensitivity.SEALED, tier: AuthzTier.HUMAN, mode: DisclosureMode.FULL }));
  assert.equal(denied.allow, false);
  const allowed = decideRelease(ctx({ sensitivity: Sensitivity.SEALED, tier: AuthzTier.MULTIFACTOR, mode: DisclosureMode.FULL }));
  assert.equal(allowed.allow, true);
});
