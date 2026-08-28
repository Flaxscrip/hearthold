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

import { StructuralSummarizer } from '../src/modules/capture-fs.ts';

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
