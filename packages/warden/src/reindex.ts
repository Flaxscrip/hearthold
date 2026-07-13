/**
 * KB re-index (backfill) — recover stored-but-unindexed KB content.
 *
 * A KB contribution seals + classifies + indexes; the index (embedding) step is best-effort, so under
 * embedder load an artefact can be stored in the vault yet never make it into the recall index — present
 * but invisible to search. This scans the vault for artefacts missing from the index, re-unseals each
 * transiently, embeds it, and adds it — idempotent (skips already-indexed) so it never duplicates. Run
 * it once the embedder is healthy: `warden kb-reindex [--kb <kbId>]`.
 */

import {
  unsealAsWarden,
  type KeymasterHandle,
  type HearthholdConfig,
} from '@hearthold/core';

import { VaultStore } from './store.js';
import { IndexStore } from './index-store.js';
import { OllamaEmbedder } from './recall.js';

/** Minimal embedder seam so the backfill is testable without a live Ollama. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface ReindexReport {
  scanned: number;
  alreadyIndexed: number;
  backfilled: number;
  /** Unsealable/placeholder artefacts with no recoverable text (skipped, not an error). */
  skipped: number;
  /** Embedder still failing on these — retry when it has headroom. */
  failed: number;
}

/**
 * Backfill the recall index from the vault. Only touches artefacts NOT already indexed, so it is safe to
 * re-run and never duplicates. `opts.kb` scopes to one KB / space / private partition (by the `kb` tag);
 * omit to sweep everything. `opts.embedder` overrides the default Ollama embedder (for tests).
 */
export async function reindexKb(
  warden: KeymasterHandle,
  config: HearthholdConfig,
  opts: { kb?: string; embedder?: Embedder } = {},
): Promise<ReindexReport> {
  const store = new VaultStore(warden.dataFolder);
  const index = new IndexStore(warden.dataFolder);
  const embedder: Embedder = opts.embedder ?? new OllamaEmbedder(config.ollamaUrl, config.embeddingModel);

  const report: ReindexReport = { scanned: 0, alreadyIndexed: 0, backfilled: 0, skipped: 0, failed: 0 };
  for (const a of await store.list()) {
    const kb = a.metadata?.kb as string | undefined;
    if (opts.kb !== undefined && kb !== opts.kb) continue;
    report.scanned++;
    if (await index.has(a.id)) {
      report.alreadyIndexed++;
      continue;
    }
    // Re-unseal transiently to get the contribution text (vault stays sealed at rest).
    let text: string | null = null;
    try {
      const plain = await unsealAsWarden(warden, a.ciphertext);
      text = (JSON.parse(plain) as { text?: string }).text ?? null;
    } catch {
      text = null; // placeholder/unsealable ciphertext (e.g. a seed marker) — nothing to embed
    }
    if (!text) {
      report.skipped++;
      continue;
    }
    try {
      const embedding = await embedder.embed(text);
      await index.put({ artefactId: a.id, kind: a.kind, observedAt: a.observedAt, sensitivity: a.sensitivity, embedding, kb });
      report.backfilled++;
    } catch {
      report.failed++; // embedder still down — leave it for a later run
    }
  }
  return report;
}
