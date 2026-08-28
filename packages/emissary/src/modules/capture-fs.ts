/**
 * `capture:fs` — a filesystem-crawler capability module (docs/emissary-modules.md, the `capture:*` family).
 *
 * A specialized INBOUND Emissary: it walks a directory and, per file, derives an on-device **structural
 * summary + metadata + content hash** — never the raw body bytes — and submits that to the Warden as a
 * `WitnessSubmission`. The Warden classifies it on-device and quarantines it born-obsidian (deny-by-default)
 * until the Sovereign admits it; the Sovereign then recalls it. So the file's CONTENT never leaves the disk —
 * the vault holds a derived summary keyed by a `sha256` that points back at the file (provenance).
 *
 * This module respects the Emissary boundary exactly: it holds a Warden-issued DELEGATION and submits
 * input-evidence — it never writes a KB space (that needs a member/Sovereign signature). Everything it
 * submits is untrusted input the Warden gates; a compromised crawler can submit noise (which is sealed and
 * quarantined) but cannot authorize a disclosure or bypass classification.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';

import { sealForWarden, PROTOCOL_VERSION, type WitnessSubmission } from '@hearthold/core';
import type { KeymasterHandle, Transport } from '@hearthold/core';

import type { CapabilityModule, ModuleContext } from '../module.js';

// ── Summarizer seam ───────────────────────────────────────────────────────────────────────────────────────

/** A file's derived, non-verbatim description — the recall signal the KB holds instead of the body. */
export interface FileSummary {
  /** A short human-readable line describing the file (title + shape), for classification + recall. */
  summary: string;
  /** Detected language for a code file (from extension). */
  language?: string;
  /** Markdown headings — the document's own table of contents (structural, not body prose). */
  headings?: string[];
  /** Top-level symbol names in a code file (function/class/export/def) — structural identifiers. */
  symbols?: string[];
  /** Line count of the file. */
  lineCount: number;
}

/** Turns a file's text into a derived summary. Swap in a local-Ollama summarizer behind this same interface. */
export interface FileSummarizer {
  summarize(input: { relPath: string; ext: string; content: string }): Promise<FileSummary> | FileSummary;
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.rb': 'Ruby', '.sh': 'Shell', '.c': 'C',
  '.cpp': 'C++', '.h': 'C', '.css': 'CSS', '.html': 'HTML', '.sql': 'SQL',
};

/**
 * The default, dependency-free summarizer. It derives ONLY a file's structural index — headings (a markdown
 * doc's own ToC), top-level symbol names (a code file's declarations), language, and line count — plus a
 * one-line description. It never emits the body prose, so the KB holds the file's "table of contents", not
 * its content. A richer, paraphrasing summary is a drop-in behind `FileSummarizer` (e.g. local Ollama).
 */
export class StructuralSummarizer implements FileSummarizer {
  summarize(input: { relPath: string; ext: string; content: string }): FileSummary {
    const { relPath, ext, content } = input;
    const lines = content.split(/\r?\n/);
    const lineCount = lines.length;
    const language = LANG_BY_EXT[ext.toLowerCase()];

    let headings: string[] | undefined;
    let symbols: string[] | undefined;

    if (ext.toLowerCase() === '.md' || ext.toLowerCase() === '.markdown') {
      headings = lines
        .filter((l) => /^#{1,6}\s+\S/.test(l))
        .map((l) => l.replace(/^#{1,6}\s+/, '').trim())
        .slice(0, 40);
    } else if (language) {
      // Cheap top-level declaration scan — names only, never bodies.
      const names = new Set<string>();
      for (const l of lines) {
        const m =
          /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(l) ??
          /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/.exec(l) ??
          /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z0-9_]+)/.exec(l) ??
          /^\s*def\s+([A-Za-z0-9_]+)/.exec(l) ??
          /^\s*(?:pub\s+)?fn\s+([A-Za-z0-9_]+)/.exec(l);
        if (m?.[1]) names.add(m[1]);
        if (names.size >= 40) break;
      }
      symbols = [...names];
    }

    const shape = headings?.length
      ? `${headings.length} heading(s)`
      : symbols?.length
        ? `${symbols.length} symbol(s)`
        : `${lineCount} line(s)`;
    const isMarkdown = ext.toLowerCase() === '.md' || ext.toLowerCase() === '.markdown';
    const kindWord = isMarkdown ? 'markdown document' : language ? `${language} source` : ext ? `${ext.slice(1)} file` : 'file';
    const summary = `${kindWord} "${basename(relPath)}" — ${lineCount} lines, ${shape}`;

    return { summary, ...(language ? { language } : {}), ...(headings?.length ? { headings } : {}), ...(symbols?.length ? { symbols } : {}), lineCount };
  }
}

// ── The crawl ─────────────────────────────────────────────────────────────────────────────────────────────

/** The text extensions v1 handles. Everything else is skipped (metadata-only extraction is a later mode). */
export const DEFAULT_TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.rst', '.json', '.yaml', '.yml', '.toml', '.csv',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go', '.java', '.rb', '.sh',
  '.c', '.cpp', '.h', '.css', '.html', '.sql',
];

/** Directory names never descended into. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.hearthold', '.hearthold-e2e']);

export interface CrawlDeps {
  /** The Emissary's own wallet — used to seal each summary to the Warden. */
  handle: KeymasterHandle;
  /** The Warden the observations are submitted to. */
  wardenDid: string;
  /** How submissions reach the Warden (request/response over DIDComm). */
  transport: Transport;
  /**
   * Produce a fresh delegation proof for a submission (the Emissary presenting its Warden-issued delegation).
   * Returns `undefined` if no delegation is available — the crawl then reports each file as unauthorized
   * rather than submitting blind. Injected so the CLI (challenge over DIDComm) and tests (local challenge)
   * supply it differently.
   */
  presentDelegation: () => Promise<string | undefined>;
  /** Defaults to `StructuralSummarizer`. */
  summarizer?: FileSummarizer;
}

export interface CrawlOptions {
  /** The directory to crawl. */
  root: string;
  /** Preview only — summarize but do not seal or submit. */
  dryRun?: boolean;
  /** Skip files larger than this many bytes (default 1 MiB). */
  maxBytes?: number;
  /** Override the handled extensions. */
  extensions?: string[];
  /** Fixed observation timestamp (for deterministic tests). */
  observedAt?: string;
}

export interface CrawlFileResult {
  relPath: string;
  sha256?: string;
  bytes?: number;
  summary?: string;
  /** The Warden-assigned artefact id (content hash of the ciphertext), from the receipt. */
  artefactId?: string;
  /** Present when the file was not submitted (extension filtered, too big, unreadable, unauthorized, error). */
  skipped?: string;
}

export interface CrawlReport {
  root: string;
  scanned: number;
  submitted: number;
  skipped: number;
  dryRun: boolean;
  files: CrawlFileResult[];
}

/** Recursively list files under `root`, skipping noise dirs and symlink loops (by not following symlinks). */
async function* walk(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/**
 * Crawl `opts.root`, submitting a derived summary per handled file to the Warden. Returns a report; never
 * throws for a single bad file (it's recorded as `skipped`). The RAW CONTENT never leaves this process — only
 * the structural summary + metadata + `sha256` is sealed and sent.
 */
export async function crawlDirectory(deps: CrawlDeps, opts: CrawlOptions): Promise<CrawlReport> {
  const summarizer = deps.summarizer ?? new StructuralSummarizer();
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const exts = new Set((opts.extensions ?? DEFAULT_TEXT_EXTENSIONS).map((e) => e.toLowerCase()));
  const report: CrawlReport = { root: opts.root, scanned: 0, submitted: 0, skipped: 0, dryRun: !!opts.dryRun, files: [] };

  for await (const full of walk(opts.root)) {
    report.scanned += 1;
    const relPath = relative(opts.root, full);
    const ext = extname(full).toLowerCase();
    const rec: CrawlFileResult = { relPath };

    if (!exts.has(ext)) {
      rec.skipped = `unhandled extension ${ext || '(none)'}`;
      report.skipped += 1;
      report.files.push(rec);
      continue;
    }

    let content: string;
    let bytes: number;
    try {
      const info = await stat(full);
      bytes = info.size;
      if (bytes > maxBytes) {
        rec.skipped = `too large (${bytes} > ${maxBytes} bytes)`;
        report.skipped += 1;
        report.files.push(rec);
        continue;
      }
      content = await readFile(full, 'utf8');
    } catch (err) {
      rec.skipped = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
      report.skipped += 1;
      report.files.push(rec);
      continue;
    }

    const sha256 = createHash('sha256').update(content).digest('hex');
    const summary = await summarizer.summarize({ relPath, ext, content });
    rec.sha256 = sha256;
    rec.bytes = bytes;
    rec.summary = summary.summary;

    // The recall-able text is the DERIVED summary + structural index — never the body. Metadata carries the
    // provenance (`sha256` → the on-disk file) so a disclosure can prove which file a fact came from without
    // the file leaving the machine.
    const metadata = { source: 'capture:fs', relPath, ext, bytes, sha256, ...(summary.language ? { language: summary.language } : {}) };
    const recallText = [
      summary.summary,
      summary.headings?.length ? `Headings: ${summary.headings.join(' · ')}` : '',
      summary.symbols?.length ? `Symbols: ${summary.symbols.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    if (opts.dryRun) {
      report.files.push(rec);
      continue;
    }

    const delegationProof = await deps.presentDelegation();
    if (!delegationProof) {
      rec.skipped = 'no delegation available — Emissary not authorized to submit';
      report.skipped += 1;
      report.files.push(rec);
      continue;
    }

    try {
      const ciphertext = await sealForWarden(deps.handle, deps.wardenDid, JSON.stringify({ text: recallText, metadata }));
      const submission: WitnessSubmission = {
        type: 'hearthold/witness-submission',
        version: PROTOCOL_VERSION,
        kind: 'document',
        observedAt: opts.observedAt ?? new Date().toISOString(),
        ciphertext,
        delegationProof,
      };
      const reply = await deps.transport.request(deps.wardenDid, submission);
      if (reply.type === 'hearthold/submission-receipt') {
        rec.artefactId = (reply as { artefactId?: string }).artefactId;
        report.submitted += 1;
      } else {
        rec.skipped = `warden refused: ${(reply as { reason?: string }).reason ?? reply.type}`;
        report.skipped += 1;
      }
    } catch (err) {
      rec.skipped = `submit failed: ${err instanceof Error ? err.message : String(err)}`;
      report.skipped += 1;
    }
    report.files.push(rec);
  }

  return report;
}

// ── The module ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `capture:fs` capability module. Exposes `POST /api/crawl { path, dryRun? }`, which runs `crawlDirectory`
 * with the deps this module was constructed with. Built as a factory (deps closed over) rather than reading
 * them from `ModuleContext`, because a submitting module needs the wallet + Warden binding that the minimal
 * context does not carry — the same way `introspect` needs nothing and takes no deps.
 */
export function captureFsModule(deps: CrawlDeps): CapabilityModule {
  let ctx: ModuleContext | undefined;
  return {
    name: 'capture:fs',
    init(c) {
      ctx = c;
    },
    httpRoutes: {
      'POST /api/crawl': async ({ body }) => {
        void ctx; // reserved for future per-request context (audience, session)
        const b = (body ?? {}) as { path?: string; dryRun?: boolean; maxBytes?: number };
        if (!b.path) throw new Error('crawl: `path` is required');
        const report = await crawlDirectory(deps, { root: b.path, dryRun: b.dryRun, maxBytes: b.maxBytes });
        return { report };
      },
    },
  };
}
