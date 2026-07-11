/**
 * Recall — the private-archive side of Hearthold.
 *
 * The *other* mode to prove: instead of disclosing to a third party, the Sovereign asks their own
 * vault a question and a **local** model answers from it (RAG). Everything here runs on the Warden's
 * hardware — the query, the retrieval, and the answer never leave the device.
 *
 * This module is the pure, transport-free core: an embedding seam, cosine ranking, and the shapes the
 * Warden's `RecallService` fills. The vector index holds embeddings + metadata only (no plaintext);
 * content is re-unsealed transiently at recall time, so the vault stays sealed at rest.
 */

/** Produces an embedding vector for a piece of text. Implemented by a local model (Ollama). */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** One indexed artefact — its embedding + the metadata needed to rank and cite it. No plaintext. */
export interface IndexEntry {
  artefactId: string;
  kind: string;
  observedAt: string;
  sensitivity: number;
  embedding: number[];
  /** Which Knowledge Base this entry belongs to; absent = the Warden's own (personal) vault. */
  kb?: string;
}

/** Cosine similarity of two equal-length vectors (0 if either is degenerate). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ScoredEntry {
  entry: IndexEntry;
  score: number;
}

/**
 * Rank index entries against a query embedding, most-similar first. `maxSensitivity` drops anything
 * above a ceiling; `kb` scopes retrieval: a single KB id, an ARRAY of ids (the caller's *visible set* —
 * their shared partition + their own private partition, for KB Spaces), or `null` for the personal vault
 * only. This is what keeps one KB's (or one member's private partition's) content from surfacing in
 * another's query on a multi-KB Warden.
 */
export function rankByQuery(
  queryEmbedding: number[],
  entries: IndexEntry[],
  opts: { k?: number; maxSensitivity?: number; kb?: string | string[] | null } = {},
): ScoredEntry[] {
  const k = opts.k ?? 5;
  const ceiling = opts.maxSensitivity ?? Number.POSITIVE_INFINITY;
  const kbSet = Array.isArray(opts.kb) ? new Set(opts.kb) : null;
  const kbMatch = (e: IndexEntry): boolean => {
    if (opts.kb === undefined) return true; // no scope → all entries
    if (opts.kb === null) return e.kb === undefined; // personal vault only
    if (kbSet) return e.kb !== undefined && kbSet.has(e.kb); // visible set (union of partitions)
    return e.kb === opts.kb; // exactly this KB
  };
  return entries
    .filter((e) => e.sensitivity <= ceiling && kbMatch(e))
    .map((entry) => ({ entry, score: cosineSimilarity(queryEmbedding, entry.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** A citation to a supporting artefact behind a recall answer. */
export interface RecallCitation {
  artefactId: string;
  kind: string;
  observedAt: string;
  score: number;
}

/** The answer to a recall query, with the artefacts it drew on. Machine-derived; local-only. */
export interface RecallResult {
  query: string;
  answer: string;
  citations: RecallCitation[];
  /** Recall answers are model-generated over the vault — fallible, and never a verifiable claim alone. */
  descriptionSource: 'machine-derived';
}
