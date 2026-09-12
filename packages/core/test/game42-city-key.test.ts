import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cityCanonical, cityKappa, game42ToCityKey, importCityKeyV1 } from '../src/game42.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../demos/star-hold/city-key-v1.vectors.json', import.meta.url), 'utf8'));

for (const vector of vectors.vectors) {
  test(`City Key independent vector: ${vector.id}`, () => {
    assert.equal(cityCanonical(vector.content), vector.canonical);
    assert.equal(cityKappa(vector.content), vector.kappa);
    const original = JSON.stringify({ ...vector.content, kappa: vector.kappa }, null, 2) + '\n';
    const imported = importCityKeyV1(original);
    assert.equal(imported.integrity, 'matched');
    assert.equal(imported.authority, 'unverified');
    assert.equal(imported.originalJson, original);
    assert.deepEqual(imported.key, JSON.parse(original));
    assert.equal(importCityKeyV1(imported.originalJson).derivedKappa, vector.kappa);
  });
}

const base = vectors.vectors[0].content;
test('unlabelled import derives content without stamping or claiming authority', () => {
  const result = importCityKeyV1(JSON.stringify(base));
  assert.equal(result.integrity, 'unlabelled');
  assert.equal(result.authority, 'unverified');
  assert.equal(Object.hasOwn(result.key, 'kappa'), false);
});

test('existing Game of 42 producer without descriptions still imports', () => {
  const key = game42ToCityKey({ name: 'Synthetic board', groupSeal: 'a'.repeat(64), savedAt: '2026-09-12T00:00:00Z' });
  assert.equal(key.descriptions, undefined);
  assert.equal(importCityKeyV1(JSON.stringify(key)).derivedKappa, key.kappa);
});

test('unknown fields, nested kappa, holds and prior remain content; only top-level kappa is excluded', () => {
  const content = vectors.vectors[1].content;
  const changed = structuredClone(content);
  changed.extension.kappa = 'changed';
  assert.notEqual(cityKappa(changed), cityKappa(content));
  changed.extension = content.extension;
  changed.holds.count++;
  assert.notEqual(cityKappa(changed), cityKappa(content));
  assert.notEqual(cityKappa({ ...content, prior: 'sha256:' + 'f'.repeat(64) }), cityKappa(content));
  assert.equal(cityKappa({ ...content, kappa: 'ignored' }), cityKappa(content));
});

test('object insertion order is immaterial, array order is content', () => {
  const a = { ...base, extension: { z: 1, a: [1, 2] } };
  const b = { extension: { a: [1, 2], z: 1 }, ...base };
  assert.equal(cityKappa(a), cityKappa(b));
  b.extension.a.reverse();
  assert.notEqual(cityKappa(a), cityKappa(b));
});

test('stale hash, malformed carrier and invalid Hold commitment refuse', () => {
  for (const value of [null, [], { ...base, version: 2 }, { ...base, name: 1 },
    { ...base, palette: {} }, { ...base, descriptions: [] }, { ...base, descriptions: { '1': 2 } },
    { ...base, prior: null }, { ...base, kappa: 'bad' }, { ...base, kappa: 'sha256:' + '0'.repeat(64) },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(count => ({ ...base, holds: { root: 'sha256:' + 'a'.repeat(64), count } })),
    { ...base, holds: { root: 'bad', count: 1 } }]) {
    assert.throws(() => importCityKeyV1(JSON.stringify(value)));
  }
});

test('non-finite JSON numbers, excessive nesting and oversized input refuse', () => {
  assert.throws(() => importCityKeyV1(JSON.stringify(base).replace('"version":1', '"version":1e400')), /non-finite/);
  assert.throws(() => importCityKeyV1('['.repeat(66) + '0' + ']'.repeat(66)), /nesting/);
  assert.throws(() => importCityKeyV1(' '.repeat(1024 * 1024 + 1)), /1 MiB/);
});
