/**
 * Drift guard: control-types' browser-safe `requiredLevelFor` MIRROR must agree with core's authoritative
 * one for every sensitivity. The Table derives the proof-of-human level from the mirror; core gates on its
 * own copy. They live across a package boundary (core does not depend on control-types), so nothing but this
 * test keeps them in lockstep — a divergence fails here rather than silently mis-rendering the human gate.
 *
 * Runs with NO live node/Ollama via `node --experimental-strip-types --test` (part of `npm run test:unit`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requiredLevelFor as coreRequiredLevelFor, Sensitivity } from '../src/security.ts';
import {
  requiredLevelFor as ctRequiredLevelFor,
  controlActionLabel,
  HEARTHOLD_CONTROL_ACTIONS,
} from '../../control-types/src/index.ts';

test('control-types requiredLevelFor MIRRORS core across every sensitivity (0..4)', () => {
  for (let s = 0; s <= 4; s += 1) {
    assert.equal(
      ctRequiredLevelFor(s),
      coreRequiredLevelFor(s),
      `sensitivity ${s}: control-types mirror (${ctRequiredLevelFor(s)}) disagrees with core (${coreRequiredLevelFor(s)})`,
    );
  }
});

test('requiredLevelFor: SEALED is the level-2 class an AgentGate (level 1) cannot self-satisfy', () => {
  // The whole point of the Trinity UI Tier-2 boundary: SEALED needs level 2; agent self-approval caps at 1.
  assert.equal(coreRequiredLevelFor(Sensitivity.SEALED), 2);
  assert.equal(coreRequiredLevelFor(Sensitivity.HIGH), 1); // an agent CAN self-approve HIGH (level 1)
  assert.equal(coreRequiredLevelFor(Sensitivity.MEDIUM), 1);
  assert.equal(coreRequiredLevelFor(Sensitivity.LOW), 0); // standing delegation suffices
  assert.equal(coreRequiredLevelFor(Sensitivity.PUBLIC), 0);
});

test('controlActionLabel: known actions map, unknown falls back to the raw string (never throws)', () => {
  assert.equal(controlActionLabel('mint-root-capability'), HEARTHOLD_CONTROL_ACTIONS['mint-root-capability']);
  assert.equal(controlActionLabel('grant-capability'), 'Grant a capability');
  assert.equal(controlActionLabel('some-future-verb'), 'some-future-verb');
});
