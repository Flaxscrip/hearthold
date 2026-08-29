/**
 * 📖 The Book Worm — `capture:web`, a book-ingestion Emissary capability module (docs/emissary-modules.md).
 *
 * Reads a web-published book into a Hearthold recall index so it can be QUESTIONED. Fetch a table-of-contents
 * page → discover chapter URLs → fetch each chapter → extract text → chunk by section → hand each passage to a
 * `sink`, which embeds + stores it. Recall then answers questions over the passages, citing the chapter +
 * section each answer drew on. The book stays where it is; only the derived index is built.
 *
 * The value is the PRIVATE-book case: a custodian holds a manuscript and answers "KB-style" prompts about it
 * without ever handing over the text. A public book (where this boundary is moot) is just the easy demo.
 *
 * Design: the orchestration (fetch → chunk) is pure and injectable — `fetchText` and `sink` are supplied by
 * the caller, so the module is unit-testable with a stub fetch + a collector sink (no network, no model), and
 * the SAME code serves a warden-side direct-index (the demo) or a DIDComm submit. Book content is bulk PUBLIC,
 * so a book sink indexes at PUBLIC and skips per-chunk classification — that on-device sensitivity gate is for
 * a person's private observations, not a published manuscript.
 */
import type { CapabilityModule } from '../module.js';

// ── HTML → text (regex-based: fine for clean-prose book sites — no math/footnotes/figures) ──────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…',
};

/** Decode HTML entities (named + numeric) to text. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))) // hex numeric (e.g. &#x27;)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))) // decimal numeric (e.g. &#39;)
    .replace(/&([a-z0-9#]+);/gi, (m, e) => ENTITIES[e] ?? ENTITIES[String(e).toLowerCase()] ?? m);
}

/** Drop non-content regions (script/style/nav/header/footer), collapse tags to text with paragraph breaks. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|section|article)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

const firstMatch = (html: string, re: RegExp): string | undefined => re.exec(html)?.[1];

export interface BookSection {
  heading: string;
  text: string;
}
export interface BookChapter {
  url: string;
  title: string;
  sections: BookSection[];
}

/** Extract a chapter: its <h1> title and its <h2>-delimited sections (or one section if there are no h2s). */
export function extractChapter(html: string, url: string): BookChapter {
  const title = decodeEntities(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)?.replace(/<[^>]+>/g, '') ?? '').trim() || url;
  const body = firstMatch(html, /<body[^>]*>([\s\S]*?)<\/body>/i) ?? html;
  const sections: BookSection[] = [];
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2[^>]*>|<\/body>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const heading = decodeEntities((m[1] ?? '').replace(/<[^>]+>/g, '')).trim();
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
export function chunkChapter(ch: BookChapter, maxWords = 1100, overlap = 120): { section: string; text: string }[] {
  const out: { section: string; text: string }[] = [];
  for (const s of ch.sections) {
    const words = s.text.split(/\s+/);
    if (words.length <= maxWords) {
      out.push({ section: s.heading, text: s.text });
      continue;
    }
    for (let i = 0; i < words.length; i += Math.max(1, maxWords - overlap)) {
      out.push({ section: s.heading, text: words.slice(i, i + maxWords).join(' ') });
    }
  }
  return out;
}

/** Discover chapter URLs from a TOC page: hrefs like `01-title.html`, resolved absolute, in order, deduped. */
export function chapterUrls(tocHtml: string, tocUrl: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const m of tocHtml.matchAll(/href="([^"]*\d{2}-[^"]+\.html)"/gi)) {
    let abs: string;
    try {
      abs = new URL(m[1]!, tocUrl).toString();
    } catch {
      continue;
    }
    if (!/\/index\.html$/i.test(abs) && !seen.has(abs)) {
      seen.add(abs);
      urls.push(abs);
    }
  }
  return urls;
}

/**
 * Discover VOLUME table-of-contents URLs from a corpus index page: hrefs into a numbered volume directory
 * (`NN-name/` or `NN-name/index.html`), normalized to that directory's `index.html`, in order, deduped.
 * Also picks up a `00-front/` front-matter directory when present.
 */
export function volumeUrls(corpusHtml: string, corpusUrl: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const m of corpusHtml.matchAll(/href="([^"]*\d{2}-[^"/]+\/(?:index\.html)?)"/gi)) {
    let abs: string;
    try {
      abs = new URL(m[1]!, corpusUrl).toString().replace(/\/$/, '/index.html');
    } catch {
      continue;
    }
    if (!/\/index\.html$/i.test(abs)) abs = `${abs.replace(/\/$/, '')}/index.html`;
    if (!seen.has(abs)) {
      seen.add(abs);
      urls.push(abs);
    }
  }
  return urls;
}

// ── Ingestion (orchestration; fetch + sink injected so it's testable and persistence-agnostic) ──────────────

/** One book passage handed to the sink to embed + store. `index` is the chunk's ordinal within its chapter. */
export interface BookChunk {
  chapterTitle: string;
  section: string;
  url: string;
  index: number;
  text: string;
  /** The volume TOC URL this chapter belongs to — present when ingesting a whole corpus. */
  volume?: string;
}

export interface BookWormDeps {
  /** Fetch a URL's text (real `fetch` in production; a stub in tests). */
  fetchText: (url: string) => Promise<string>;
  /** Persist one passage — embed + index (warden-side) or submit (DIDComm). The module is agnostic to which. */
  sink: (chunk: BookChunk) => Promise<void>;
  /** Optional progress callback per chapter. */
  onChapter?: (title: string, chunks: number, url: string) => void;
}

export interface IngestBookOptions {
  tocUrl: string;
  /** Cap chapters ingested (undefined / Infinity = the whole book). */
  maxChapters?: number;
  maxWordsPerChunk?: number;
  /** The volume TOC URL to stamp on each chunk's provenance (set by `ingestCorpus`). */
  volume?: string;
}

export interface IngestReport {
  tocUrl: string;
  chapters: number;
  chunks: number;
  /** Per-chapter counts (chapters that failed to fetch are reported with `error`). */
  perChapter: { url: string; title?: string; chunks: number; error?: string }[];
}

/**
 * Read a book: discover chapters from the TOC, then fetch → extract → chunk → `sink` each passage. Never
 * throws for one bad chapter (it's recorded with `error`). Returns a report. The raw text flows only to the
 * sink — nothing is retained here.
 */
export async function ingestBook(deps: BookWormDeps, opts: IngestBookOptions): Promise<IngestReport> {
  const max = opts.maxChapters ?? Infinity;
  const toc = await deps.fetchText(opts.tocUrl);
  const urls = chapterUrls(toc, opts.tocUrl).slice(0, max);
  const report: IngestReport = { tocUrl: opts.tocUrl, chapters: 0, chunks: 0, perChapter: [] };

  for (const url of urls) {
    let chapter: BookChapter;
    try {
      chapter = extractChapter(await deps.fetchText(url), url);
    } catch (err) {
      report.perChapter.push({ url, chunks: 0, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const pieces = chunkChapter(chapter, opts.maxWordsPerChunk);
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      await deps.sink({ chapterTitle: chapter.title, section: p.section, url, index: i, text: p.text, ...(opts.volume ? { volume: opts.volume } : {}) });
    }
    report.chapters += 1;
    report.chunks += pieces.length;
    report.perChapter.push({ url, title: chapter.title, chunks: pieces.length });
    deps.onChapter?.(chapter.title, pieces.length, url);
  }
  return report;
}

export interface CorpusReport {
  corpusUrl: string;
  volumes: number;
  chapters: number;
  chunks: number;
  perVolume: { url: string; chapters: number; chunks: number; error?: string }[];
}

/**
 * Read a whole CORPUS: discover volume TOCs from the corpus index, then `ingestBook` each. Each passage's
 * provenance carries its `volume`. Never throws for one bad volume. `onVolume` fires per volume for progress.
 */
export async function ingestCorpus(
  deps: BookWormDeps & { onVolume?: (volumeUrl: string, chapters: number, chunks: number) => void },
  opts: { corpusUrl: string; maxVolumes?: number; maxChaptersPerVolume?: number; maxWordsPerChunk?: number },
): Promise<CorpusReport> {
  const corpus = await deps.fetchText(opts.corpusUrl);
  const vols = volumeUrls(corpus, opts.corpusUrl).slice(0, opts.maxVolumes ?? Infinity);
  const report: CorpusReport = { corpusUrl: opts.corpusUrl, volumes: 0, chapters: 0, chunks: 0, perVolume: [] };

  for (const volumeUrl of vols) {
    try {
      const r = await ingestBook(deps, {
        tocUrl: volumeUrl,
        volume: volumeUrl,
        maxChapters: opts.maxChaptersPerVolume,
        maxWordsPerChunk: opts.maxWordsPerChunk,
      });
      report.volumes += 1;
      report.chapters += r.chapters;
      report.chunks += r.chunks;
      report.perVolume.push({ url: volumeUrl, chapters: r.chapters, chunks: r.chunks });
      deps.onVolume?.(volumeUrl, r.chapters, r.chunks);
    } catch (err) {
      report.perVolume.push({ url: volumeUrl, chapters: 0, chunks: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

// ── The module ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The 📖 Book Worm capability module (`capture:web`). Exposes `POST /api/read-book { tocUrl, maxChapters? }`,
 * ingesting the book through the injected `deps` (a warden-side embed+index sink, or a DIDComm submit sink).
 */
export function bookwormModule(deps: BookWormDeps): CapabilityModule {
  return {
    name: 'capture:web',
    httpRoutes: {
      'POST /api/read-book': async ({ body }) => {
        const b = (body ?? {}) as { tocUrl?: string; maxChapters?: number };
        if (!b.tocUrl) throw new Error('read-book: `tocUrl` is required');
        const report = await ingestBook(deps, { tocUrl: b.tocUrl, maxChapters: b.maxChapters });
        return { report };
      },
    },
  };
}
