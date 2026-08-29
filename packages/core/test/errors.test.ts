/**
 * Unit tests for `describeError` — the fix for the opaque `warden: [object Object]` sink (#63). A non-Error
 * thrown value (a bare object from the gatekeeper/HTTP client) must render legibly instead of "[object Object]".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeError } from '../src/errors.ts';

test('an Error yields its message', () => {
  assert.equal(describeError(new Error('boom')), 'boom');
});

test('a string yields itself', () => {
  assert.equal(describeError('plain'), 'plain');
});

test('a non-Error object prefers a message-like field (this is the [object Object] bug)', () => {
  assert.equal(describeError({ message: 'registry local not supported' }), 'registry local not supported');
  assert.equal(describeError({ error: 'nope' }), 'nope');
  assert.equal(describeError({ reason: 'why' }), 'why');
  assert.notEqual(describeError({ message: 'x' }), '[object Object]');
});

test('a non-Error object with no message field falls back to JSON, never "[object Object]"', () => {
  const out = describeError({ status: 404, body: 'Endpoint not found' });
  assert.equal(out, '{"status":404,"body":"Endpoint not found"}');
  assert.notEqual(out, '[object Object]');
});

test('a circular object degrades to String() rather than throwing from the error handler', () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  const out = describeError(o); // must not throw
  assert.equal(typeof out, 'string');
});

test('null / undefined / number are stringified safely', () => {
  assert.equal(describeError(null), 'null');
  assert.equal(describeError(undefined), 'undefined');
  assert.equal(describeError(42), '42');
});
