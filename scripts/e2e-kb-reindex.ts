/**
 * e2e: kb-reindex — backfill stored-but-unindexed KB content (deterministic, no Ollama).
 *
 * Reproduces the failure we hit live: an artefact is SEALED + stored in the vault but its embed dropped,
 * so it never entered the recall index (present but unsearchable). Then `reindexKb` re-unseals it, embeds
 * (via an injected stub embedder), and indexes it — idempotent (a second run backfills nothing), scoped
 * by kb tag, and skipping unsealable placeholders.
 *
 * Run:  npm run e2e:kb-reindex
 */
import {
  loadConfig, openKeymaster, ensureIdentity, sealForWarden, contentId, Sensitivity,
} from '@hearthold/core';
import { VaultStore, type Artefact } from '@hearthold/warden/store';
import { IndexStore } from '@hearthold/warden/index-store';
import { reindexKb, type Embedder } from '@hearthold/warden/reindex';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const warden = await openKeymaster('warden', config, 'hearthold-e2e-reindex');
  const id = await ensureIdentity(warden, config);
  const vault = new VaultStore(warden.dataFolder);
  const index = new IndexStore(warden.dataFolder);

  // Store a real, sealed KB contribution — but DON'T index it (simulates the dropped embed).
  const seal = async (text: string, kb: string): Promise<string> => {
    const ciphertext = await sealForWarden(warden, id.did, JSON.stringify({ text }));
    const aid = contentId(ciphertext, warden.cipher);
    const artefact: Artefact = { id: aid, kind: 'document', observedAt: new Date().toISOString(), storedAt: new Date().toISOString(), sensitivity: Sensitivity.LOW, ciphertext, metadata: { kb } };
    await vault.put(artefact);
    return aid;
  };
  const a1 = await seal('Keymaster is the client-side wallet library.', 'test-kb');
  const a2 = await seal('Drawbridge is the L402 API gateway.', 'test-kb');
  const aOther = await seal('a fact in another KB', 'other-kb');
  // A placeholder-ciphertext artefact (like a seed marker) — unsealable, must be skipped, not errored.
  await vault.put({ id: 'placeholder-1', kind: 'document', observedAt: new Date().toISOString(), storedAt: new Date().toISOString(), sensitivity: Sensitivity.LOW, ciphertext: '(sealed)', metadata: { kb: 'test-kb' } });

  assert(!(await index.has(a1)) && !(await index.has(a2)), 'the two contributions are stored but NOT indexed (the bug)');

  const stub: Embedder = { embed: async () => [0.1, 0.2, 0.3] };

  // Reindex scoped to test-kb.
  const r = await reindexKb(warden, config, { kb: 'test-kb', embedder: stub });
  process.stdout.write(`  reindex(test-kb): ${JSON.stringify(r)}\n`);
  assert(r.backfilled === 2, 'both stored-but-unindexed test-kb artefacts are backfilled');
  assert(r.skipped === 1, 'the unsealable placeholder is skipped (not an error)');
  assert(await index.has(a1) && await index.has(a2), 'the contributions are now in the recall index');
  assert(!(await index.has(aOther)), 'the other-kb artefact is untouched (kb scope respected)');

  // Idempotent — a second run backfills nothing.
  const r2 = await reindexKb(warden, config, { kb: 'test-kb', embedder: stub });
  assert(r2.backfilled === 0 && r2.alreadyIndexed === 2, 're-running backfills nothing (idempotent, no duplicates)');

  // A failing embedder is reported, not swallowed.
  const aFail = await seal('will not embed', 'test-kb');
  const failing: Embedder = { embed: async () => { throw new Error('embedder down'); } };
  const r3 = await reindexKb(warden, config, { kb: 'test-kb', embedder: failing });
  assert(r3.failed === 1 && !(await index.has(aFail)), 'a failing embed is counted as failed (retry later), not silently lost');

  process.stdout.write('\n✓ kb-reindex: backfills unindexed content, idempotent, kb-scoped, reports failures\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-reindex: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
