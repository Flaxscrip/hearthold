/**
 * Star Hold conformance — the City Key κ primitive.
 *
 * Pure (no live node): asserts Hearthold's κ derivation matches PrivacyMage's City canonicalization
 * profile, that verifyCityKey returns the reference client's three verdicts, and that packetsDigest
 * reproduces PrivacyMage's PUBLISHED Merkle conformance vector — a real cross-implementation check
 * that our port of Law L5 matches the Star's origin byte-for-byte.
 *
 * Run: node --experimental-strip-types scripts/e2e-star-key.ts   (or: npm run e2e:star-key)
 */

import { createHash } from 'node:crypto';
import {
  canonicalCityJSON,
  deriveKappa,
  verifyCityKey,
  derivePacketProof,
  packetsDigest,
  type StarCityKey,
} from '@hearthold/core';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('Star Hold · City Key κ conformance\n');

// 1. Canonicalization profile: recursive key-sort, array order preserved, no whitespace.
console.log('canonicalCityJSON (City profile)');
check(
  'keys sorted recursively, no whitespace',
  canonicalCityJSON({ b: 1, a: { d: 2, c: 3 } }) === '{"a":{"c":3,"d":2},"b":1}',
  canonicalCityJSON({ b: 1, a: { d: 2, c: 3 } }),
);
check('array order preserved', canonicalCityJSON([3, 1, 2]) === '[3,1,2]');
check('primitives via JSON.stringify', canonicalCityJSON('x\n"') === '"x\\n\\""');

// 2. κ derivation + the three verdicts.
console.log('\nderiveKappa / verifyCityKey');
const base: StarCityKey = {
  version: 1,
  name: 'Test Mage',
  palette: { cool: '#123', warm: '#456', sword: '#789', mage: '#abc' },
  descriptions: ['a', 'b'],
  prior: null,
  // an unknown additive field — MUST stay in the preimage and survive the round trip
  geometry: { walks: 3, extra: { z: 1, y: 2 } },
};
const kappa = deriveKappa(base);
check('κ has sha256: prefix + 64 hex', /^sha256:[0-9a-f]{64}$/.test(kappa), kappa);

const unnamed = verifyCityKey(base);
check("no stamp → 'unnamed'", unnamed.status === 'unnamed');

const named: StarCityKey = { ...base, kappa };
const authentic = verifyCityKey(named);
check("stamped κ that re-derives → 'authentic'", authentic.status === 'authentic');

// κ must exclude only the TOP-LEVEL kappa from its own preimage; stamping must not change it.
check('stamping κ does not change the derived κ (kappa excluded from preimage)', deriveKappa(named) === kappa);

const tampered: StarCityKey = { ...named, name: 'Someone Else' };
check("content change with stale stamp → 'mismatch'", verifyCityKey(tampered).status === 'mismatch');

// SHAPE ≠ VIEW: reordering keys / whitespace-free re-serialization yields the same κ.
const reordered: StarCityKey = {
  geometry: { extra: { y: 2, z: 1 }, walks: 3 },
  descriptions: ['a', 'b'],
  palette: { mage: '#abc', sword: '#789', warm: '#456', cool: '#123' },
  name: 'Test Mage',
  prior: null,
  version: 1,
};
check('key order does not affect κ (SHAPE ≠ VIEW)', deriveKappa(reordered) === kappa);

// unknown-field preservation: dropping an additive field DOES change κ (it is content).
const { geometry: _dropped, ...withoutGeometry } = base as Record<string, unknown>;
check('dropping an additive field changes κ (unknown fields are content)', deriveKappa(withoutGeometry as StarCityKey) !== kappa);

// 3. Tracing Protocol: a packet proof excludes `proof`, not `kappa`.
console.log('\nderivePacketProof (Law L5, proof excluded)');
const pkt = { kind: 'vouch', at: '2026-09-12', proof: 'IGNORED' };
const { proof: _p, ...pktNoProof } = pkt;
check(
  'proof field excluded from a packet proof preimage',
  derivePacketProof(pkt) === `sha256:${createHash('sha256').update(canonicalCityJSON(pktNoProof), 'utf8').digest('hex')}`,
);

// 4. PUBLISHED conformance vector — packetsDigest Merkle root over three named leaves.
console.log('\npacketsDigest (published Merkle conformance vector)');
const leaf = (s: string): string => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
const root = packetsDigest([leaf('packet-alpha'), leaf('packet-beta'), leaf('packet-gamma')]);
const EXPECTED = 'sha256:07f20f689c8bef2d8a9a2a71d94e7014ea8398cc603b0ff72dadba5c517983d1';
check('three leaves → published root', root === EXPECTED, `got ${root}`);
check('empty set → null', packetsDigest([]) === null);

console.log('');
if (failures > 0) {
  console.error(`FAILED — ${failures} check(s) did not pass.`);
  process.exit(1);
}
console.log('PASS — Star Hold κ primitive matches the City canonicalization profile and the published vector.');
