/**
 * The Warden's recall service — private RAG over the vault.
 *
 * The Sovereign asks a question; the Warden embeds it with a local model, ranks the index, re-unseals
 * the top matches transiently, and a local model answers from them with citations. Query, retrieval,
 * and answer all stay on the Warden's hardware — nothing crosses the boundary.
 *
 * The answer is `machine-derived` (fallible, and not a verifiable claim on its own). To *prove* a
 * recalled fact, wrap it in an evidence graph via the prove flow.
 */

import {
  unsealAsWarden,
  rankByQuery,
  type Embedder,
  type IndexEntry,
  type RecallResult,
  type RecallCitation,
  type KeymasterHandle,
  type HearthholdConfig,
} from '@hearthold/core';

import { VaultStore } from './store.js';
import { IndexStore } from './index-store.js';

/** Local Ollama embedding model (default nomic-embed-text). Stays on-device. */
export class OllamaEmbedder implements Embedder {
  constructor(
    private readonly url: string,
    private readonly model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.url}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text.slice(0, 8000) }),
    });
    if (!res.ok) throw new Error(`ollama embeddings ${res.status}`);
    const data = (await res.json()) as { embedding?: number[] };
    if (!data.embedding?.length) throw new Error('ollama returned no embedding');
    return data.embedding;
  }
}

/** Resolves an artefact's plaintext at recall time (re-unseal). Injectable for tests. */
export type ContentResolver = (artefactId: string) => Promise<string | null>;

/** Answers a query from retrieved snippets. Injectable; the live one calls a local chat model. */
export type Answerer = (query: string, passages: { observedAt: string; text: string }[]) => Promise<string>;

const SYSTEM_PROMPT = `You are a private recall assistant answering ONLY from the user's own archived
notes below. Answer the question concisely from the notes. If the notes don't contain the answer, say
you don't have it. Do not invent facts. /no_think`;

/** Build the live answerer: a local Ollama chat model over the retrieved passages. */
export function ollamaAnswerer(url: string, model: string): Answerer {
  return async (query, passages) => {
    const context = passages.map((p, i) => `[${i + 1}] (${p.observedAt}) ${p.text}`).join('\n');
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Notes:\n${context}\n\nQuestion: ${query}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama chat ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return (data.message?.content ?? '').trim();
  };
}

export interface RecallOptions {
  k?: number;
  /** Drop artefacts above this sensitivity from recall (e.g. exclude SEALED). */
  maxSensitivity?: number;
  /** Scope to one Knowledge Base (kbId), or `null` for the personal vault only. Omit = all. */
  kb?: string | null;
}

export class RecallService {
  private readonly index: IndexStore;

  constructor(
    private readonly embedder: Embedder,
    private readonly resolve: ContentResolver,
    private readonly answer: Answerer,
    dataFolder: string,
  ) {
    this.index = new IndexStore(dataFolder);
  }

  /** Convenience factory wiring the live Ollama embedder/answerer + re-unseal resolver to a Warden. */
  static forWarden(warden: KeymasterHandle, config: HearthholdConfig): RecallService {
    const store = new VaultStore(warden.dataFolder);
    const resolve: ContentResolver = async (id) => {
      const a = await store.get(id);
      if (!a) return null;
      try {
        const plain = await unsealAsWarden(warden, a.ciphertext);
        // Submissions are sealed JSON `{text}`; fall back to the raw string.
        try {
          return (JSON.parse(plain) as { text?: string }).text ?? plain;
        } catch {
          return plain;
        }
      } catch {
        return null; // e.g. seed placeholder ciphertext — skip, don't break recall
      }
    };
    return new RecallService(
      new OllamaEmbedder(config.ollamaUrl, config.embeddingModel),
      resolve,
      ollamaAnswerer(config.ollamaUrl, config.classifierModel),
      warden.dataFolder,
    );
  }

  /** Answer a query from the vault. Returns the answer + the artefacts it drew on. */
  async recall(query: string, opts: RecallOptions = {}): Promise<RecallResult> {
    const entries: IndexEntry[] = await this.index.list();
    if (entries.length === 0) {
      return { query, answer: 'Nothing has been indexed yet.', citations: [], descriptionSource: 'machine-derived' };
    }
    const queryEmbedding = await this.embedder.embed(query);
    const ranked = rankByQuery(queryEmbedding, entries, { k: opts.k ?? 5, maxSensitivity: opts.maxSensitivity, kb: opts.kb });

    const passages: { observedAt: string; text: string }[] = [];
    const citations: RecallCitation[] = [];
    for (const { entry, score } of ranked) {
      const text = await this.resolve(entry.artefactId);
      if (!text) continue;
      passages.push({ observedAt: entry.observedAt, text });
      citations.push({ artefactId: entry.artefactId, kind: entry.kind, observedAt: entry.observedAt, score });
    }

    if (passages.length === 0) {
      return { query, answer: "I couldn't retrieve any readable notes for that.", citations: [], descriptionSource: 'machine-derived' };
    }
    const answer = await this.answer(query, passages);
    return { query, answer, citations, descriptionSource: 'machine-derived' };
  }
}
