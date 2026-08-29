/**
 * Unit tests for `withResolverFallback` — the optional public-resolver fallback for DID RESOLUTION only.
 * It decouples data custody (stays on the bound node) from identity resolution (a public DID doc is not
 * secret). The security-load-bearing behaviours: local-first (never leave for a DID the bound node has),
 * fallback resolves with `{verify:true}`, a substituted identity is refused (returned id must match), and
 * every non-resolve method stays on the PRIMARY (so anchoring/export/import never touch the fallback). Pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withResolverFallback, type DidResolver } from '../src/resolver-fallback.ts';

const doc = (id: string): unknown => ({ didDocument: { id }, didResolutionMetadata: {} });
const NOT_FOUND: unknown = { didDocument: {}, didResolutionMetadata: { error: 'notFound' } };
const idOf = (d: unknown): unknown => (d as { didDocument?: { id?: unknown } }).didDocument?.id;

test('no fallback configured → the primary is returned UNCHANGED (full isolation)', () => {
  const primary: DidResolver = { resolveDID: async () => doc('did:cid:x') };
  assert.equal(withResolverFallback(primary, undefined), primary);
});

test('primary resolves → the fallback is NEVER consulted', async () => {
  let fbCalls = 0;
  const primary: DidResolver = { resolveDID: async () => doc('did:cid:local') };
  const fallback: DidResolver = { resolveDID: async () => { fbCalls++; return doc('did:cid:local'); } };
  const g = withResolverFallback(primary, fallback);
  assert.equal(idOf(await g.resolveDID('did:cid:local')), 'did:cid:local');
  assert.equal(fbCalls, 0, 'a DID the bound node resolves never leaves it');
});

test('primary NOT-FOUND → fallback consulted, and with {verify:true}', async () => {
  let seenOpts: Record<string, unknown> | undefined;
  const primary: DidResolver = { resolveDID: async () => NOT_FOUND };
  const fallback: DidResolver = { resolveDID: async (did, o) => { seenOpts = o; return doc(did!); } };
  const g = withResolverFallback(primary, fallback);
  assert.equal(idOf(await g.resolveDID('did:cid:remote')), 'did:cid:remote');
  assert.equal(seenOpts?.verify, true, 'the fallback validates the document (untrusted-for-correctness)');
});

test('primary THROWS → fallback still consulted', async () => {
  const primary: DidResolver = { resolveDID: async () => { throw new Error('Invalid DID: unknown'); } };
  const fallback: DidResolver = { resolveDID: async (did) => doc(did!) };
  const g = withResolverFallback(primary, fallback);
  assert.equal(idOf(await g.resolveDID('did:cid:remote')), 'did:cid:remote');
});

test('fallback returns a DIFFERENT id → REFUSED (no substituted identity)', async () => {
  const primary: DidResolver = { resolveDID: async () => NOT_FOUND };
  const fallback: DidResolver = { resolveDID: async () => doc('did:cid:ATTACKER') };
  const g = withResolverFallback(primary, fallback);
  await assert.rejects(() => g.resolveDID('did:cid:victim'), /≠ requested DID|substituted identity/);
});

test('non-resolveDID methods delegate to the PRIMARY (anchoring/export stay local)', async () => {
  const primary = { resolveDID: async () => NOT_FOUND, exportDIDs: async () => 'primary' } as DidResolver & { exportDIDs(): Promise<string> };
  const fallback = { resolveDID: async () => doc('x'), exportDIDs: async () => 'FALLBACK' } as DidResolver & { exportDIDs(): Promise<string> };
  const g = withResolverFallback(primary, fallback);
  assert.equal(await g.exportDIDs(), 'primary', 'export/anchoring never touches the fallback resolver');
});
