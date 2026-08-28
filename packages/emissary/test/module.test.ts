/**
 * Unit tests for the Emissary runtime (`src/module.ts`) — the capability-module registry. Pure logic, no
 * node: composition, collision-refusal (name / route / message-type), atomic registration, one-time init,
 * merged routes, and type-dispatch. These are the invariants a "library of Emissaries" rests on — a silent
 * last-writer-wins on a route or message type would be a real confused-surface bug, so they are pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Emissary, type CapabilityModule, type ModuleContext } from '../src/module.ts';

const mod = (name: string, over: Partial<CapabilityModule> = {}): CapabilityModule => ({ name, ...over });
const ctx = { did: 'did:cid:test', name: 'emissary', nodeUrl: 'http://node.test' };

test('use() composes modules and loadout() reports them in load order', () => {
  const e = new Emissary().use(mod('a')).use(mod('b')).use(mod('c'));
  assert.deepEqual(e.loadout(), ['a', 'b', 'c']);
});

test('duplicate module name is refused at use()', () => {
  const e = new Emissary().use(mod('dup'));
  assert.throws(() => e.use(mod('dup')), /duplicate module name 'dup'/);
});

test('an HTTP route claimed by two modules is refused (no silent last-writer-wins)', () => {
  const e = new Emissary().use(mod('a', { httpRoutes: { 'GET /api/x': async () => ({}) } }));
  assert.throws(
    () => e.use(mod('b', { httpRoutes: { 'GET /api/x': async () => ({}) } })),
    /route 'GET \/api\/x' claimed by both 'a' and 'b'/,
  );
});

test('a message type claimed by two modules is refused', () => {
  const e = new Emissary().use(mod('a', { messageHandlers: { 'hh/ping': async () => null } }));
  assert.throws(
    () => e.use(mod('b', { messageHandlers: { 'hh/ping': async () => null } })),
    /message type 'hh\/ping' claimed by both 'a' and 'b'/,
  );
});

test('a rejected module leaves NO partial registration (atomic use)', () => {
  const e = new Emissary().use(mod('a', { httpRoutes: { 'GET /api/x': async () => ({}) } }));
  // b collides on /api/x but ALSO declares /api/y; the whole use() must fail without committing /api/y.
  assert.throws(() =>
    e.use(mod('b', { httpRoutes: { 'GET /api/x': async () => ({}), 'GET /api/y': async () => ({}) } })),
  );
  // So a later module may still claim /api/y — proof b's routes were never committed.
  assert.doesNotThrow(() => e.use(mod('c', { httpRoutes: { 'GET /api/y': async () => ({}) } })));
  assert.deepEqual(e.loadout(), ['a', 'c']);
});

test('routes() merges every module route into one table for the control server', () => {
  const e = new Emissary()
    .use(mod('a', { httpRoutes: { 'GET /api/x': async () => ({}) } }))
    .use(mod('b', { httpRoutes: { 'POST /api/y': async () => ({}) } }));
  assert.deepEqual(Object.keys(e.routes()).sort(), ['GET /api/x', 'POST /api/y']);
});

test('handler() dispatches by message type to the owning module, else null', async () => {
  const e = new Emissary()
    .use(mod('a', { messageHandlers: { 'hh/ping': async () => ({ type: 'hh/pong' } as never) } }))
    .use(mod('b', { messageHandlers: { 'hh/hello': async () => ({ type: 'hh/hi' } as never) } }));
  const h = e.handler();
  assert.deepEqual(await h({ type: 'hh/ping' } as never, 'did:cid:from'), { type: 'hh/pong' });
  assert.deepEqual(await h({ type: 'hh/hello' } as never, 'did:cid:from'), { type: 'hh/hi' });
  assert.equal(await h({ type: 'hh/unknown' } as never, 'did:cid:from'), null);
});

test('init() runs each module once with a context that exposes loadout + manifest', async () => {
  const seen: ModuleContext[] = [];
  let calls = 0;
  const spy = mod('spy', { init: (c) => { calls += 1; seen.push(c); } });
  const e = new Emissary().use(spy).use(mod('other', { httpRoutes: { 'GET /api/z': async () => ({}) } }));
  await e.init(ctx);
  assert.equal(calls, 1);
  assert.deepEqual(seen[0]?.loadout(), ['spy', 'other']);
  assert.deepEqual(seen[0]?.manifest().find((m) => m.name === 'other')?.routes, ['GET /api/z']);
  // Second init is a no-op — modules are not re-wired.
  await e.init(ctx);
  assert.equal(calls, 1);
});

test('use() after init() is refused (loadout is frozen once wired)', async () => {
  const e = new Emissary().use(mod('a'));
  await e.init(ctx);
  await assert.rejects(async () => e.use(mod('late')), /cannot add module 'late' after init/);
});

test('manifest() reports each module\'s routes and message types', () => {
  const e = new Emissary().use(
    mod('full', {
      httpRoutes: { 'GET /api/a': async () => ({}) },
      messageHandlers: { 'hh/t': async () => null },
    }),
  );
  assert.deepEqual(e.manifest(), [{ name: 'full', routes: ['GET /api/a'], messageTypes: ['hh/t'] }]);
});
