/**
 * demo: book → KB → answers. Read a large web-published book with the local models and build a Hearthold
 * recall index over it, then ask questions and get answers with CHAPTER/SECTION provenance.
 *
 * The pipeline (a `capture:web` book variant): fetch a table-of-contents page → discover chapter URLs →
 * fetch each chapter → extract text → chunk by section → embed each chunk on-device (nomic-embed-text) →
 * store sealed in the Warden vault + index for recall. Then RecallService answers a query over the passages
 * with a local RAG model, citing the chapter + section each answer drew on.
 *
 * Why through the Warden (not generic RAG): this is the PRIVATE-book story. The custodian HOLDS the book and
 * answers questions; a reader gets an answer + provenance, never the manuscript. For a PUBLIC book (like this
 * one) that access boundary is moot — but the SAME pipeline serves an author who keeps the text private and
 * only exposes "KB-style" prompts. Book content is bulk PUBLIC, so we index at PUBLIC and skip per-chunk
 * classification (that on-device gate is for a person's private observations, not a published manuscript).
 *
 * Needs a live Archon node + Ollama (embed + answer models). A walkthrough, not an assertion.
 *
 *   HEARTHOLD_PASSPHRASE=… npm run demo:book-kb
 *   HEARTHOLD_PASSPHRASE=… npm run demo:book-kb -- <tocUrl> "<question>" [maxChapters|all]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  sealForWarden,
  Sensitivity,
  type KeymasterHandle,
} from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { QuarantineClassifier } from '@hearthold/warden/classifier';
import { OllamaEmbedder, RecallService } from '@hearthold/warden/recall';
import { VaultStore, type Artefact } from '@hearthold/warden/store';

const DEFAULT_TOC = 'https://axionic.org/book/01-physics-of-agency/index.html';
const DEFAULT_QUERY = 'What is agency, and how does the book relate it to entropy and choice?';
const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-book-kb');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-book-kb';
const say = (m = ''): void => process.stdout.write(`${m}\n`);
const rule = (): void => say('─'.repeat(78));

// ── HTML → text (this site is clean prose: no math/footnotes/figures per inspection) ────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…',
};
const decode = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z0-9#]+);/gi, (m, e) => ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m);

/** Drop non-content regions, then collapse tags to text with paragraph breaks. */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|section|article)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(stripped)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

const firstMatch = (html: string, re: RegExp): string | undefined => re.exec(html)?.[1];

interface Section {
  heading: string;
  text: string;
}
interface Chapter {
  url: string;
  title: string;
  sections: Section[];
}

/** Split a chapter's <body> by <h2> headings into sections. Falls back to one section if there are no h2s. */
function extractChapter(html: string, url: string): Chapter {
  const title = decode(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)?.replace(/<[^>]+>/g, '') ?? '').trim() || url;
  const body = firstMatch(html, /<body[^>]*>([\s\S]*?)<\/body>/i) ?? html;
  const sections: Section[] = [];
  // Match each <h2>…</h2> and the content up to the next <h2> (or end).
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2[^>]*>|<\/body>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const heading = decode((m[1] ?? '').replace(/<[^>]+>/g, '')).trim();
    const text = htmlToText(m[2] ?? '');
    if (text.split(/\s+/).length >= 8) sections.push({ heading: heading || '(untitled)', text });
  }
  if (sections.length === 0) {
    const text = htmlToText(body);
    if (text) sections.push({ heading: title, text });
  }
  return { url, title, sections };
}

/** One chunk per section; a very long section is windowed with overlap so no chunk is unwieldy. */
function chunkChapter(ch: Chapter, maxWords = 1100, overlap = 120): { section: string; text: string }[] {
  const out: { section: string; text: string }[] = [];
  for (const s of ch.sections) {
    const words = s.text.split(/\s+/);
    if (words.length <= maxWords) {
      out.push({ section: s.heading, text: s.text });
      continue;
    }
    for (let i = 0; i < words.length; i += maxWords - overlap) {
      out.push({ section: s.heading, text: words.slice(i, i + maxWords).join(' ') });
    }
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'Hearthold-book-kb/0.1 (+recall demo)' } });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
}

/** Discover chapter URLs from a TOC page: hrefs like `01-title.html`, resolved against the TOC URL, in order. */
function chapterUrls(tocHtml: string, tocUrl: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const m of tocHtml.matchAll(/href="([^"]*\d{2}-[^"]+\.html)"/gi)) {
    const abs = new URL(m[1]!, tocUrl).toString();
    if (!/\/index\.html$/i.test(abs) && !seen.has(abs)) {
      seen.add(abs);
      urls.push(abs);
    }
  }
  return urls;
}

async function main(): Promise<void> {
  const tocUrl = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : DEFAULT_TOC;
  const query = process.argv[3] ?? DEFAULT_QUERY;
  const maxArg = process.argv[4];
  const maxChapters = maxArg === 'all' ? Infinity : Number(maxArg ?? 4);
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };

  rule();
  say('  Hearthold · book → KB → answers   (read a book with local models, ask it questions)');
  rule();
  say(`  book:  ${tocUrl}`);
  say(`  model: ${config.ollamaUrl} (embed=${config.embeddingModel}, answer=${config.answerModel})`);

  const warden: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const wardenId = await ensureIdentity(warden, config);
  const embedder = new OllamaEmbedder(config.ollamaUrl, config.embeddingModel);
  const svc = new WardenService(warden, new QuarantineClassifier(), embedder); // classifier unused (direct index)
  const vault = new VaultStore(warden.dataFolder);

  say('\n▶ 1. DISCOVER chapters from the table of contents');
  const toc = await fetchText(tocUrl);
  const urls = chapterUrls(toc, tocUrl).slice(0, maxChapters);
  say(`   found ${urls.length} chapter(s)${Number.isFinite(maxChapters) ? ` (limited to ${maxChapters}; pass 'all' for the whole book)` : ''}`);

  say('\n▶ 2. FETCH + CHUNK + EMBED each chapter (on-device) — the text stays here, only the index is built');
  const provenance = new Map<string, { chapter: string; section: string; url: string }>();
  let chunks = 0;
  const now = new Date().toISOString();
  for (const url of urls) {
    let ch: Chapter;
    try {
      ch = extractChapter(await fetchText(url), url);
    } catch (err) {
      say(`   – ${url} — skipped: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const pieces = chunkChapter(ch);
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const payload = JSON.stringify({ text: p.text, metadata: { source: 'book', chapter: ch.title, section: p.section, url } });
      const ciphertext = await sealForWarden(warden, wardenId.did, payload);
      const id = createHash('sha256').update(ciphertext).digest('hex');
      const artefact: Artefact = { id, kind: 'book', observedAt: now, storedAt: now, sensitivity: Sensitivity.PUBLIC, ciphertext, metadata: { chapter: ch.title, section: p.section, url } };
      await vault.put(artefact);
      await svc.indexArtefact(artefact, p.text); // embed the passage text into the recall index
      provenance.set(id, { chapter: ch.title, section: p.section, url });
      chunks++;
    }
    say(`   ✓ ${ch.title}  —  ${pieces.length} chunk(s)`);
  }
  say(`   indexed ${chunks} passage(s) across ${urls.length} chapter(s), all at PUBLIC (bulk book content).`);

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
  say('  For a PRIVATE book, that is the whole point: the custodian answers; the text never leaves.');
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
