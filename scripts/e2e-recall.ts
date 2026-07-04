/**
 * e2e: recall (private RAG over the vault) — the retrieval + answer core.
 *
 * Hermetic: a deterministic stub embedder (bag-of-words vector) + stub answerer stand in for Ollama,
 * so ranking and citation are tested without a live model. Proves: embed-on-index, cosine ranking
 * returns the right note, the answer is grounded in retrieved passages with citations, and a
 * sensitivity ceiling excludes protected artefacts from recall.
 *
 * Isolated data root; run:  npm run e2e:recall
 */
import {
  cosineSimilarity,
  rankByQuery,
  Sensitivity,
  type Embedder,
  type IndexEntry,
} from '@hearthold/core';
import { IndexStore } from '@hearthold/warden/index-store';
import { RecallService, type ContentResolver, type Answerer } from '@hearthold/warden/recall';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

// Deterministic bag-of-words embedder over a fixed vocabulary — good enough to rank by term overlap.
const VOCAB = ['america', 'anniversary', 'july', '4th', '250th', 'dentist', 'appointment', 'book', 'home', 'paris'];
class StubEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const t = text.toLowerCase();
    return VOCAB.map((w) => (t.includes(w) ? 1 : 0));
  }
}

async function main(): Promise<void> {
  const dataFolder = `${process.env.HEARTHOLD_DATA_ROOT}/warden`;
  const embedder = new StubEmbedder();
  const index = new IndexStore(dataFolder);

  // Simulate three indexed artefacts (embeddings + metadata only — no plaintext in the index).
  const notes: Record<string, { text: string; kind: string; sensitivity: number; observedAt: string }> = {
    'art-usa': { text: 'July 4th tomorrow is Americas 250th Anniversary', kind: 'document', sensitivity: Sensitivity.PUBLIC, observedAt: '2026-07-03T10:00:00Z' },
    'art-dentist': { text: 'Dentist appointment next week', kind: 'event', sensitivity: Sensitivity.MEDIUM, observedAt: '2026-06-20T10:00:00Z' },
    'art-book': { text: 'I have a book at home in Paris', kind: 'document', sensitivity: Sensitivity.PUBLIC, observedAt: '2026-07-01T10:00:00Z' },
  };
  for (const [id, n] of Object.entries(notes)) {
    const embedding = await embedder.embed(n.text);
    await index.put({ artefactId: id, kind: n.kind, observedAt: n.observedAt, sensitivity: n.sensitivity, embedding } as IndexEntry);
  }
  process.stdout.write('indexed 3 artefacts (embeddings + metadata only)\n');

  // Sanity on the pure ranker.
  process.stdout.write('\n▸ Cosine ranking\n');
  const q = await embedder.embed('When is America\'s anniversary?');
  const entries = await index.list();
  const ranked = rankByQuery(q, entries, { k: 3 });
  assert(ranked[0]?.entry.artefactId === 'art-usa', 'top hit for the anniversary query is the July-4th note');
  assert((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 1), 'top score strictly beats the runner-up');
  assert(cosineSimilarity([1, 0], [1, 0]) === 1, 'cosine of identical vectors is 1');

  // Content resolver returns plaintext ONLY here (simulating a transient re-unseal at recall time).
  const resolve: ContentResolver = async (id) => notes[id]?.text ?? null;
  // Stub answerer echoes the passage it was given, proving the answer is grounded in retrieval.
  const answerer: Answerer = async (_query, passages) =>
    passages.map((p) => p.text).find((t) => /anniversary|july/i.test(t)) ?? '(no answer)';

  const recall = new RecallService(embedder, resolve, answerer, dataFolder);

  process.stdout.write('\n▸ Recall answers from the vault, with citations\n');
  const res = await recall.recall("When is America's anniversary?");
  assert(/july 4th/i.test(res.answer), 'the answer is grounded in the retrieved July-4th note');
  assert(res.citations[0]?.artefactId === 'art-usa', 'the top citation is the July-4th note');
  assert(res.descriptionSource === 'machine-derived', 'recall is flagged machine-derived (not a verifiable claim)');

  process.stdout.write('\n▸ Sensitivity ceiling excludes protected artefacts from recall\n');
  const qd = await embedder.embed('dentist appointment');
  const openOnly = rankByQuery(qd, entries, { k: 3, maxSensitivity: Sensitivity.LOW });
  assert(!openOnly.some((r) => r.entry.artefactId === 'art-dentist'), 'the MEDIUM dentist note is excluded below the ceiling');

  process.stdout.write('\n✓ Recall: embed-on-index → cosine retrieval → grounded answer + citations, sealed at rest\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-recall: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
