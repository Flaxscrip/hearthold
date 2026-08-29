/**
 * Unit tests for 📖 the Book Worm (`capture:web`) — the HTML→text/chunking parsers and the ingest
 * orchestration. Regex HTML parsing is fragile, so its behaviour is pinned; `ingestBook` is exercised with a
 * STUB fetch + a COLLECTOR sink (no network, no model) so the whole discover→fetch→chunk→sink flow is
 * hermetically tested. Part of `test:unit`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeEntities,
  htmlToText,
  extractChapter,
  chunkChapter,
  chapterUrls,
  volumeUrls,
  ingestBook,
  ingestCorpus,
  type BookChunk,
  type BookWormDeps,
} from '../src/modules/bookworm.ts';

test('decodeEntities: named + decimal + HEX numeric', () => {
  assert.equal(decodeEntities('Popper &amp; Deutsch &mdash; &#39;agency&#39;'), "Popper & Deutsch — 'agency'");
  // Hex numeric — the real-book case (`Everett&#x27;s Demon`) that a decimal-only decoder left mangled.
  assert.equal(decodeEntities('Everett&#x27;s Demon'), "Everett's Demon");
  assert.equal(decodeEntities('&#x2014;'), '—');
});

test('htmlToText: drops script/style/nav, keeps prose with paragraph breaks', () => {
  const html = `<nav>Home About</nav><style>.x{}</style><p>First para.</p><script>bad()</script><p>Second &amp; last.</p>`;
  const text = htmlToText(html);
  assert.ok(!/Home About/.test(text), 'nav dropped');
  assert.ok(!/bad\(\)/.test(text), 'script dropped');
  assert.ok(text.includes('First para.') && text.includes('Second & last.'), 'prose kept + entities decoded');
});

test('extractChapter: title from h1, sections split by h2 (short sections dropped)', () => {
  const html = `<body><h1>A Genealogy of Agency</h1>
    <h2>Knowledge Without Certainty</h2><p>${'word '.repeat(20)}</p>
    <h2>The Road Ahead</h2><p>${'onward '.repeat(20)}</p>
    <h2>Stub</h2><p>too short</p></body>`;
  const ch = extractChapter(html, 'http://x/01.html');
  assert.equal(ch.title, 'A Genealogy of Agency');
  assert.deepEqual(ch.sections.map((s) => s.heading), ['Knowledge Without Certainty', 'The Road Ahead'], 'the <8-word section is dropped');
  assert.ok(ch.sections[0]!.text.startsWith('word'));
});

test('extractChapter: no h2 → one section from the whole body', () => {
  const ch = extractChapter(`<body><h1>Title</h1><p>${'prose '.repeat(30)}</p></body>`, 'u');
  assert.equal(ch.sections.length, 1);
  assert.equal(ch.sections[0]!.heading, 'Title');
});

test('chunkChapter: one chunk per section; a long section windows with overlap', () => {
  const short = chunkChapter({ url: 'u', title: 't', sections: [{ heading: 'S', text: 'a b c d e' }] });
  assert.equal(short.length, 1);

  const long = { url: 'u', title: 't', sections: [{ heading: 'Long', text: Array.from({ length: 250 }, (_, i) => `w${i}`).join(' ') }] };
  const chunks = chunkChapter(long, 100, 20);
  assert.ok(chunks.length >= 3, 'a 250-word section splits into multiple windows');
  assert.ok(chunks.every((c) => c.section === 'Long'));
  // Overlap: the 2nd window starts before the 1st ends (step = max-overlap = 80).
  assert.ok(chunks[1]!.text.startsWith('w80 '), `overlap window start, got: ${chunks[1]!.text.slice(0, 12)}`);
});

test('chapterUrls: discovers ##-*.html hrefs, resolves absolute, skips index, dedupes, keeps order', () => {
  const toc = `<a href="01-genealogy.html">1</a> <a href="02-drift.html">2</a>
    <a href="index.html">toc</a> <a href="01-genealogy.html">dup</a> <a href="about.html">x</a>`;
  const urls = chapterUrls(toc, 'https://axionic.org/book/01-physics/index.html');
  assert.deepEqual(urls, [
    'https://axionic.org/book/01-physics/01-genealogy.html',
    'https://axionic.org/book/01-physics/02-drift.html',
  ]);
});

test('ingestBook: discover → fetch → chunk → sink, hermetic (stub fetch + collector), maxChapters honoured', async () => {
  const pages: Record<string, string> = {
    'https://b/toc.html': `<a href="01-one.html">1</a><a href="02-two.html">2</a><a href="03-three.html">3</a>`,
    'https://b/01-one.html': `<body><h1>One</h1><h2>Alpha</h2><p>${'w '.repeat(20)}</p></body>`,
    'https://b/02-two.html': `<body><h1>Two</h1><h2>Beta</h2><p>${'w '.repeat(20)}</p><h2>Gamma</h2><p>${'w '.repeat(20)}</p></body>`,
  };
  const collected: BookChunk[] = [];
  const deps: BookWormDeps = {
    fetchText: async (u) => {
      const p = pages[u];
      if (!p) throw new Error(`404 ${u}`);
      return p;
    },
    sink: async (c) => { collected.push(c); },
  };

  const report = await ingestBook(deps, { tocUrl: 'https://b/toc.html', maxChapters: 2 });
  assert.equal(report.chapters, 2, 'only 2 chapters (maxChapters) ingested');
  assert.equal(report.chunks, 3, 'One(1 section) + Two(2 sections)');
  assert.deepEqual(collected.map((c) => `${c.chapterTitle}/${c.section}`), ['One/Alpha', 'Two/Beta', 'Two/Gamma']);
  assert.equal(collected[0]!.url, 'https://b/01-one.html');
});

test('volumeUrls: discovers NN-name/ volume dirs, normalizes to index.html, in order, deduped', () => {
  const corpus = `<a href="00-front/index.html">front</a>
    <a href="01-physics-of-agency/index.html">v1</a>
    <a href="02-conditionalism/">v2</a>
    <a href="01-physics-of-agency/index.html">dup</a>
    <a href="about.html">x</a>`;
  const urls = volumeUrls(corpus, 'https://axionic.org/book/index.html');
  assert.deepEqual(urls, [
    'https://axionic.org/book/00-front/index.html',
    'https://axionic.org/book/01-physics-of-agency/index.html',
    'https://axionic.org/book/02-conditionalism/index.html',
  ]);
});

test('ingestCorpus: discover volumes → ingest each; chunks carry their volume; failures recorded', async () => {
  const pages: Record<string, string> = {
    'https://b/index.html': `<a href="01-vone/index.html">1</a><a href="02-vtwo/index.html">2</a>`,
    'https://b/01-vone/index.html': `<a href="01-alpha.html">a</a>`,
    'https://b/01-vone/01-alpha.html': `<body><h1>Alpha</h1><h2>S</h2><p>${'w '.repeat(20)}</p></body>`,
    // 02-vtwo's TOC is missing → volume ingest still runs (ingestBook fetches the TOC and throws → caught).
  };
  const collected: BookChunk[] = [];
  const deps: BookWormDeps = {
    fetchText: async (u) => {
      const p = pages[u];
      if (!p) throw new Error(`404 ${u}`);
      return p;
    },
    sink: async (c) => { collected.push(c); },
  };
  const report = await ingestCorpus(deps, { corpusUrl: 'https://b/index.html' });
  assert.equal(report.volumes, 1, 'v1 ingested; v2 TOC 404 → recorded, not thrown');
  assert.equal(report.chunks, 1);
  assert.equal(collected[0]!.volume, 'https://b/01-vone/index.html', 'the chunk carries its volume');
  assert.ok(report.perVolume.some((v) => v.error), 'the failed volume is recorded');
});

test('ingestBook: a chapter that fails to fetch is recorded as an error, not thrown', async () => {
  const deps: BookWormDeps = {
    fetchText: async (u) => (u.endsWith('toc.html') ? `<a href="01-ok.html">1</a><a href="02-bad.html">2</a>` : u.includes('01-ok') ? `<body><h1>Ok</h1><h2>S</h2><p>${'w '.repeat(20)}</p></body>` : Promise.reject(new Error('boom'))),
    sink: async () => {},
  };
  const report = await ingestBook(deps, { tocUrl: 'https://b/toc.html' });
  assert.equal(report.chapters, 1, 'the good chapter ingested');
  assert.ok(report.perChapter.some((c) => c.error === 'boom'), 'the bad chapter is recorded with its error');
});
