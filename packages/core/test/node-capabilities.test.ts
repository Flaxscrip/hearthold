/**
 * Unit tests for the node-capability permissive semantics — the check that gates DIDComm features and the
 * cross-node handshake. The rule (matching the keymaster's `requireNodeCapability`): a capability is
 * supported UNLESS the node explicitly reports `false`; "unknown" (null / absent key) is permitted, so old
 * nodes without a capabilities endpoint are never broken. Getting this backwards would either refuse a good
 * node or trust a node that said no — so it's worth pinning. Pure functions, no node; part of `test:unit`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeSupports, nodeExplicitlyLacks, type NodeCapabilities } from '../src/node-capabilities.ts';

test('nodeSupports: explicit true and false are honoured', () => {
  assert.equal(nodeSupports({ didcomm: true }, 'didcomm'), true);
  assert.equal(nodeSupports({ didcomm: false }, 'didcomm'), false);
});

test('nodeSupports: UNKNOWN is permitted — null caps and absent keys both count as supported', () => {
  assert.equal(nodeSupports(null, 'didcomm'), true, 'unreachable/unknown node ⇒ permit (old nodes not broken)');
  assert.equal(nodeSupports(undefined, 'didcomm'), true);
  assert.equal(nodeSupports({}, 'didcomm'), true, 'absent key ⇒ permit, not refuse');
  assert.equal(nodeSupports({ lightning: true } as NodeCapabilities, 'didcomm'), true);
});

test('nodeExplicitlyLacks: true ONLY when the node says false — unknown must not read as "lacks"', () => {
  assert.equal(nodeExplicitlyLacks({ didcomm: false }, 'didcomm'), true);
  assert.equal(nodeExplicitlyLacks({ didcomm: true }, 'didcomm'), false);
  assert.equal(nodeExplicitlyLacks(null, 'didcomm'), false, 'unknown ≠ lacks — never fail-fast on a node we could not reach');
  assert.equal(nodeExplicitlyLacks({}, 'didcomm'), false, 'absent key ≠ lacks');
});

test('the two checks are complementary only on EXPLICIT values — unknown is supported AND not-lacking', () => {
  // The asymmetry is the point: an unreachable node is permitted (supported) yet not "explicitly lacking",
  // so a permissive caller proceeds while a fail-fast caller does NOT refuse it.
  assert.equal(nodeSupports(null, 'x'), true);
  assert.equal(nodeExplicitlyLacks(null, 'x'), false);
  // On an explicit false, both agree it is unsupported / lacking.
  assert.equal(nodeSupports({ x: false }, 'x'), false);
  assert.equal(nodeExplicitlyLacks({ x: false }, 'x'), true);
});
