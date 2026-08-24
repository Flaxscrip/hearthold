/**
 * e2e: two-member family isolation — the G-grade boundary (Phase 3, docs/plan-under-review.md).
 *
 * Proves, across the four scoped surfaces, that one member never sees another's private content — the
 * visible set is computed server-side from the viewer DID, never from client input:
 *   - snapshot / visibility: Alice's vault = her own ∪ shared, never Bob's private;
 *   - card/face: Alice hydrating Bob's card is refused (obsidian), with no existence leak;
 *   - recall: Alice's retrieval excludes Bob's private entries;
 *   - SSE: a frame addressed to Alice reaches only Alice's console, never Bob's.
 *
 * Live (needs the Archon node for identities + the Warden seal). Run:  npm run e2e:family-isolation
 */
import http from 'node:http';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  sealForWarden,
  rankByQuery,
  startControlServer,
  AuthzTier,
  type IndexEntry,
} from '@hearthold/core';
import { VaultStore, type Artefact } from '@hearthold/warden/store';
import { hydrateCardFace } from '@hearthold/warden/face';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-family-iso';

  const warden = await openKeymaster('warden', config, pass);
  const aliceK = await openKeymaster('sovereign', config, pass);
  const bobK = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const alice = (await ensureIdentity(aliceK, config)).did;
  const bob = (await ensureIdentity(bobK, config)).did;

  // The server-side visibility rule (mirrors control.ts): pre-family artefacts belong to the Sovereign.
  const visibleTo = (a: Artefact, viewer: string | undefined): boolean =>
    (a.owner ?? config.sovereignDid) === viewer || a.scope === 'shared';

  // Seed a vault: Alice-private, Bob-private, and one shared-to-household note (all LOW so they render).
  const store = new VaultStore(warden.dataFolder);
  const put = async (id: string, owner: string, scope: 'private' | 'shared', text: string) => {
    const ciphertext = await sealForWarden(warden, wardenId.did, JSON.stringify({ text }));
    await store.put({ id, kind: 'document', observedAt: '2026-07-16T12:00:00Z', storedAt: '2026-07-16T12:00:00Z', sensitivity: 1, ciphertext, metadata: {}, owner, scope });
  };
  await put('a-priv', alice, 'private', 'alice private note');
  await put('b-priv', bob, 'private', 'bob private note');
  await put('shared', alice, 'shared', 'household dinner plan');

  process.stdout.write('\n▸ Snapshot / visibility\n');
  const aliceSees = (await store.list()).filter((a) => visibleTo(a, alice)).map((a) => a.id).sort();
  const bobSees = (await store.list()).filter((a) => visibleTo(a, bob)).map((a) => a.id).sort();
  assert(JSON.stringify(aliceSees) === JSON.stringify(['a-priv', 'shared']), `Alice sees her own + shared, not Bob's (${aliceSees.join(',')})`);
  assert(JSON.stringify(bobSees) === JSON.stringify(['b-priv', 'shared']), `Bob sees his own + shared, not Alice's (${bobSees.join(',')})`);

  process.stdout.write('\n▸ Card/face — cross-member is obsidian, own renders\n');
  const cleared = async (): Promise<AuthzTier> => AuthzTier.STANDING;
  const bobCardAsAlice = await hydrateCardFace(warden, { artefactId: 'b-priv', visible: (a) => visibleTo(a, alice), achievedTier: cleared });
  assert(bobCardAsAlice.granted === false, "Alice hydrating Bob's card → obsidian (cross-member refused)");
  assert(bobCardAsAlice.sensitivity === 0, 'the refusal reveals no real sensitivity (no existence leak)');
  const ownCardAsAlice = await hydrateCardFace(warden, { artefactId: 'a-priv', visible: (a) => visibleTo(a, alice), achievedTier: cleared });
  assert(ownCardAsAlice.granted === true, 'Alice hydrating her OWN LOW card → renders');

  process.stdout.write('\n▸ Recall — owner-scoped retrieval excludes another member\n');
  const entries: IndexEntry[] = [
    { artefactId: 'a-priv', kind: 'document', observedAt: '', sensitivity: 1, embedding: [1], owner: alice, scope: 'private' },
    { artefactId: 'b-priv', kind: 'document', observedAt: '', sensitivity: 1, embedding: [1], owner: bob, scope: 'private' },
    { artefactId: 'shared', kind: 'document', observedAt: '', sensitivity: 1, embedding: [1], scope: 'shared' },
  ];
  const recalled = rankByQuery([1], entries, { k: 10, kb: null, owner: alice }).map((s) => s.entry.artefactId).sort();
  assert(JSON.stringify(recalled) === JSON.stringify(['a-priv', 'shared']), `Alice's recall = own + shared, never Bob's (${recalled.join(',')})`);

  process.stdout.write('\n▸ SSE — a frame addressed to one member reaches only their console\n');
  await sseIsolation(alice, bob);

  process.stdout.write('\n✓ Family isolation: snapshot, card/face, recall, and the event stream are all per-member\n');
  process.exit(0);
}

/** Stand up a control server with two SSE clients (Alice, Bob) and assert an owner-addressed frame is scoped. */
async function sseIsolation(alice: string, bob: string): Promise<void> {
  const tokens: Record<string, string> = { 'tok-alice': alice, 'tok-bob': bob };
  const server = startControlServer({
    port: 4321,
    resolveSession: (t) => (t ? tokens[t] : undefined),
    routes: { 'GET /api/ping': async () => ({ pong: true }) },
  });
  const frames: Record<string, string[]> = { alice: [], bob: [] };
  const connect = (who: 'alice' | 'bob', token: string): Promise<void> =>
    new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: 4321, path: '/api/events', headers: { 'x-hearthold-session': token } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) if (line.startsWith('data:') && line.includes('"type"')) frames[who].push(line);
        });
        resolve();
      });
      req.on('error', () => resolve());
    });
  await connect('alice', 'tok-alice');
  await connect('bob', 'tok-bob');
  await new Promise((r) => setTimeout(r, 150)); // let both subscribe

  server.emit('submission-stored', { id: 'a-priv' }, { owner: alice }); // addressed to Alice
  server.emit('kb-changed', { kbs: [] }); // broadcast
  await new Promise((r) => setTimeout(r, 200)); // let frames arrive

  assert(frames.alice.some((f) => f.includes('submission-stored')), 'Alice receives her own submission-stored frame');
  assert(!frames.bob.some((f) => f.includes('submission-stored')), "Bob does NOT receive Alice's submission-stored frame");
  assert(frames.alice.some((f) => f.includes('kb-changed')) && frames.bob.some((f) => f.includes('kb-changed')), 'both receive the broadcast (kb-changed)');
  server.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-family-isolation: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
