/**
 * Unit tests for `capture:fs` (src/modules/capture-fs.ts) — the filesystem crawler's summarizer.
 *
 * The load-bearing property: a derived summary must carry the file's STRUCTURAL INDEX (headings / symbol
 * names / metadata) but NEVER its body prose — that is the whole privacy claim of the crawler (the content
 * stays on disk; the KB holds only derived facts + a hash). If a body token could leak into a summary, the
 * demo's "the files never left the machine" story is false. So we pin it with a distinctive body token that
 * must not appear anywhere in the summary output. Pure — no node, no fs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuralSummarizer, crawlDirectory, type CrawlDeps } from '../src/modules/capture-fs.ts';

const BODY_TOKEN = 'SECRET_BODY_TOKEN_zzz9';
const sum = new StructuralSummarizer();

test('markdown: keeps headings, drops body prose (the privacy invariant)', () => {
  const content = `# Project Roadmap\n\nThis paragraph contains ${BODY_TOKEN} which must never leave.\n\n## Deployment\n\nmore ${BODY_TOKEN} body text\n`;
  const s = sum.summarize({ relPath: 'docs/roadmap.md', ext: '.md', content });
  assert.deepEqual(s.headings, ['Project Roadmap', 'Deployment'], 'headings are the derived ToC');
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes(BODY_TOKEN), 'the body token must NOT appear anywhere in the summary');
  assert.ok(blob.includes('Roadmap'), 'the heading (structural) is present');
});

test('code: keeps top-level symbol names, drops body (the privacy invariant)', () => {
  const content =
    `export function computeThing(x) {\n  const ${BODY_TOKEN} = x * 2;\n  return ${BODY_TOKEN};\n}\n` +
    `class Widget {}\ninterface Shape { n: number }\n`;
  const s = sum.summarize({ relPath: 'src/thing.ts', ext: '.ts', content });
  assert.equal(s.language, 'TypeScript');
  assert.ok(s.symbols?.includes('computeThing') && s.symbols.includes('Widget') && s.symbols.includes('Shape'), 'declares its symbols');
  assert.ok(!JSON.stringify(s).includes(BODY_TOKEN), 'a body identifier must NOT leak into the summary');
});

test('plain text: no headings/symbols, only shape metadata (still body-free)', () => {
  const content = `just some notes\n${BODY_TOKEN} in the middle\nand a third line\n`;
  const s = sum.summarize({ relPath: 'notes.txt', ext: '.txt', content });
  assert.equal(s.headings, undefined);
  assert.equal(s.symbols, undefined);
  assert.equal(s.lineCount, 4);
  assert.ok(!JSON.stringify(s).includes(BODY_TOKEN), 'plain-text body must NOT leak');
  assert.ok(s.summary.includes('notes.txt'), 'the summary names the file');
});

test('summary line names the file and its shape, never its content', () => {
  const s = sum.summarize({ relPath: 'a/b/report.md', ext: '.md', content: '# Title\nbody\n' });
  assert.ok(s.summary.startsWith('markdown document "report.md"'), `got: ${s.summary}`);
  assert.ok(s.summary.includes('1 heading'));
});

test('language detection maps by extension', () => {
  assert.equal(sum.summarize({ relPath: 'x.py', ext: '.py', content: 'def f():\n  pass\n' }).language, 'Python');
  assert.equal(sum.summarize({ relPath: 'x.rs', ext: '.rs', content: 'fn main(){}\n' }).language, 'Rust');
  assert.equal(sum.summarize({ relPath: 'x.txt', ext: '.txt', content: 'hi\n' }).language, undefined);
});

// ── Vault-safety: the crawler must never read the Hearthold data root or a wallet ────────────────────────────
// dryRun avoids needing a live Warden — it exercises the walk/filter/refuse logic without submitting.
const noopDeps: CrawlDeps = {
  handle: {} as never,
  wardenDid: 'did:cid:warden',
  transport: {} as never,
  presentDelegation: async () => undefined,
};

test('REFUSES to crawl a path inside a protected root (the vault / data root)', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'cf-vault-'));
  try {
    await writeFile(join(dataRoot, 'warden.wallet.json'), '{"secret":"do-not-read"}');
    const report = await crawlDirectory(noopDeps, { root: dataRoot, dryRun: true, excludeRoots: [dataRoot] });
    assert.equal(report.scanned, 0, 'nothing under a protected root is even scanned');
    assert.ok(report.files.some((f) => /refused/.test(f.skipped ?? '')), 'the crawl is refused outright');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('SKIPS a protected root nested inside the crawl target, and never a wallet file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-nested-'));
  const dataRoot = join(root, '.mydata'); // a custom data root NOT named .hearthold
  try {
    await writeFile(join(root, 'ok.md'), '# Fine\nbody\n');
    await writeFile(join(root, 'stray.wallet.json'), '{"secret":"x"}'); // wallet in the open — must be skipped
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, 'vault.json'), '{"cipher":"x"}'); // inside the protected root — never scanned
    const report = await crawlDirectory(noopDeps, { root, dryRun: true, excludeRoots: [dataRoot] });
    const rels = report.files.map((f) => f.relPath);
    assert.ok(rels.includes('ok.md'), 'ordinary files are still crawled');
    assert.ok(!rels.some((r) => r.includes('.mydata')), 'the protected data root is never descended');
    const wallet = report.files.find((f) => f.relPath === 'stray.wallet.json');
    assert.ok(wallet && /wallet file/.test(wallet.skipped ?? ''), 'a wallet file is always skipped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
