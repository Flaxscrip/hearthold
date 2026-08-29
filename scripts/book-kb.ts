/**
 * demo: 📖 The Book Worm — read a web book with local models, then ask it questions.
 *
 * Drives the `capture:web` module (`packages/emissary/src/modules/bookworm.ts`): discover chapters from a
 * table-of-contents → fetch → chunk by section → embed each passage on-device → store sealed in the Warden
 * vault + index. Then RecallService answers a query with a local RAG model, citing the chapter + section.
 *
 * Through the Warden by design (the PRIVATE-book story): the custodian HOLDS the book and answers; a reader
 * gets an answer + provenance, never the manuscript. Book content is bulk PUBLIC → indexed at PUBLIC, no
 * per-chunk classification. Needs a live Archon node + Ollama (embed + answer models). A walkthrough.
 *
 *   HEARTHOLD_PASSPHRASE=… npm run demo:book-kb
 *   HEARTHOLD_PASSPHRASE=… npm run demo:book-kb -- <tocUrl> "<question>" [maxChapters|all]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { loadConfig, openKeymaster, ensureIdentity, sealForWarden, Sensitivity, type KeymasterHandle } from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { QuarantineClassifier } from '@hearthold/warden/classifier';
import { OllamaEmbedder, RecallService } from '@hearthold/warden/recall';
import { VaultStore, type Artefact } from '@hearthold/warden/store';
import { ingestBook, type BookChunk, type BookWormDeps } from '@hearthold/emissary/modules/bookworm';

const DEFAULT_TOC = 'https://axionic.org/book/01-physics-of-agency/index.html';
const DEFAULT_QUERY = 'What is agency, and how does the book relate it to entropy and choice?';
const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-book-kb');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-book-kb';
const say = (m = ''): void => process.stdout.write(`${m}\n`);
const rule = (): void => say('─'.repeat(78));

async function main(): Promise<void> {
  const tocUrl = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : DEFAULT_TOC;
  const query = process.argv[3] ?? DEFAULT_QUERY;
  const maxArg = process.argv[4];
  const maxChapters = maxArg === 'all' ? Infinity : Number(maxArg ?? 4);
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };

  rule();
  say('  📖 Hearthold Book Worm — read a book with local models, then ask it questions');
  rule();
  say(`  book:  ${tocUrl}`);
  say(`  model: ${config.ollamaUrl} (embed=${config.embeddingModel}, answer=${config.answerModel})`);

  const warden: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const wardenId = await ensureIdentity(warden, config);
  const embedder = new OllamaEmbedder(config.ollamaUrl, config.embeddingModel);
  const svc = new WardenService(warden, new QuarantineClassifier(), embedder); // classifier unused (direct index)
  const vault = new VaultStore(warden.dataFolder);
  const provenance = new Map<string, { chapter: string; section: string; url: string }>();
  const now = new Date().toISOString();

  // The sink: seal each passage to the Warden, store it, and embed it into the recall index (warden-side,
  // PUBLIC). The bookworm module orchestrates fetch+chunk and calls this per passage.
  const sink = async (c: BookChunk): Promise<void> => {
    const payload = JSON.stringify({ text: c.text, metadata: { source: 'book', chapter: c.chapterTitle, section: c.section, url: c.url } });
    const ciphertext = await sealForWarden(warden, wardenId.did, payload);
    const id = createHash('sha256').update(ciphertext).digest('hex');
    const artefact: Artefact = { id, kind: 'book', observedAt: now, storedAt: now, sensitivity: Sensitivity.PUBLIC, ciphertext, metadata: { chapter: c.chapterTitle, section: c.section, url: c.url } };
    await vault.put(artefact);
    await svc.indexArtefact(artefact, c.text);
    provenance.set(id, { chapter: c.chapterTitle, section: c.section, url: c.url });
  };

  const deps: BookWormDeps = {
    fetchText: async (url) => {
      const res = await fetch(url, { headers: { 'user-agent': 'Hearthold-BookWorm/0.1 (+recall demo)' } });
      if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
      return res.text();
    },
    sink,
    onChapter: (title, chunks) => say(`   ✓ ${title}  —  ${chunks} chunk(s)`),
  };

  say('\n▶ 1–2. DISCOVER + FETCH + CHUNK + EMBED (on-device) — the text stays here, only the index is built');
  const report = await ingestBook(deps, { tocUrl, maxChapters });
  say(`   indexed ${report.chunks} passage(s) across ${report.chapters} chapter(s), all at PUBLIC (bulk book content).`);
  for (const c of report.perChapter) if (c.error) say(`   – ${c.url} — skipped: ${c.error}`);

  say(`\n▶ 3. ASK  "${query}"`);
  const result = await RecallService.forWarden(warden, config).recall(query, { k: 6, maxSensitivity: Sensitivity.HIGH });
  say();
  rule();
  const failed = /temporarily unavailable|couldn't retrieve|Nothing has been indexed/i.test(result.answer);
  if (failed && result.citations.length === 0) {
    say(`  ${result.answer}`);
  } else {
    say(`  Answer:  ${result.answer}`);
    say();
    say('  Grounded in these passages (chapter · section — the book stayed on the server):');
    for (const c of result.citations) {
      const p = provenance.get(c.artefactId);
      say(`    · ${p?.chapter ?? '?'}  ›  ${p?.section ?? '?'}   (score ${c.score.toFixed(3)})`);
    }
  }
  rule();
  say('\n  A reader asked a question and got an answer with chapter/section provenance — never the manuscript.');
  say('  For a PRIVATE book, that is the whole point: the custodian answers; the text never leaves. 📖');
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
