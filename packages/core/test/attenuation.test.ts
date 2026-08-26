/**
 * Unit tests for monotonic attenuation — the confused-deputy guard.
 *
 * `isSubset` is the rule that makes a delegated capability only ever NARROW: a child authority must be a
 * subset of its parent in BOTH dimensions (operations AND resources). Widening must be unrepresentable in a
 * verified chain — so this is a security seam, and per the Architect's review (2026-08-26) it gets tests
 * that run WITHOUT a live node. Pure functions imported from source; run via
 * `node --experimental-strip-types --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSubset,
  normalizeAuthoritySet,
  canonicalize,
  type AuthoritySet,
} from '../src/attenuation.ts';

const A = (operations: string[], resources: string[]): AuthoritySet => ({ operations, resources });

test('isSubset: equal authority is a subset (identity delegation is allowed)', () => {
  const s = A(['prove', 'read'], ['card:x', 'card:y']);
  assert.equal(isSubset(s, s), true);
});

test('isSubset: a strict narrowing (fewer operations AND resources) is a subset', () => {
  const parent = A(['prove', 'read', 'write'], ['card:x', 'card:y', 'card:z']);
  const child = A(['read'], ['card:x']);
  assert.equal(isSubset(child, parent), true);
});

test('isSubset: WIDENING the operations is NOT a subset (the confused-deputy guard)', () => {
  const parent = A(['read'], ['card:x']);
  const child = A(['read', 'write'], ['card:x']); // adds an operation the parent never held
  assert.equal(isSubset(child, parent), false);
});

test('isSubset: WIDENING the resources is NOT a subset', () => {
  const parent = A(['read'], ['card:x']);
  const child = A(['read'], ['card:x', 'card:y']); // adds a resource the parent never held
  assert.equal(isSubset(child, parent), false);
});

test('isSubset: the empty authority is a subset of everything (narrowest possible)', () => {
  assert.equal(isSubset(A([], []), A(['prove'], ['card:x'])), true);
});

test('isSubset: nothing is a subset of the empty parent except the empty child', () => {
  assert.equal(isSubset(A([], []), A([], [])), true);
  assert.equal(isSubset(A(['read'], []), A([], [])), false);
  assert.equal(isSubset(A([], ['card:x']), A([], [])), false);
});

test('isSubset: order- and multiplicity-independent (set semantics, not array equality)', () => {
  const parent = A(['read', 'prove'], ['card:y', 'card:x']);
  const child = A(['prove', 'read', 'read'], ['card:x', 'card:x', 'card:y']); // reordered + duplicated
  assert.equal(isSubset(child, parent), true);
});

test('isSubset: partial overlap is NOT a subset (one out-of-set member is enough to refuse)', () => {
  const parent = A(['read', 'prove'], ['card:x']);
  const child = A(['read', 'delete'], ['card:x']); // 'delete' not in parent
  assert.equal(isSubset(child, parent), false);
});

test('normalizeAuthoritySet: dedupes and sorts each dimension', () => {
  const n = normalizeAuthoritySet(A(['prove', 'read', 'prove', 'read'], ['card:z', 'card:a', 'card:z']));
  assert.deepEqual(n.operations, ['prove', 'read']);
  assert.deepEqual(n.resources, ['card:a', 'card:z']);
});

test('canonicalize: deterministic — key order does not change the output', () => {
  const a = canonicalize({ operations: ['read'], resources: ['card:x'], salt: 's' });
  const b = canonicalize({ salt: 's', resources: ['card:x'], operations: ['read'] });
  assert.equal(a, b);
});

test('canonicalize: distinct values produce distinct strings (a commitment cannot collide trivially)', () => {
  const a = canonicalize(A(['read'], ['card:x']));
  const b = canonicalize(A(['read'], ['card:y']));
  assert.notEqual(a, b);
});
