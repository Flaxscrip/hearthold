import {
  Sensitivity,
  DEFAULT_SENSITIVITY,
  loadConfig,
  noThink,
  type HearthholdConfig,
} from '@hearthold/core';

/**
 * The Warden's classifier. Its defining invariant is that it runs entirely on hardware the
 * Sovereign controls (a local Ollama model) — no artefact content is ever sent to a cloud service.
 */
export interface Classification {
  sensitivity: Sensitivity;
  /** Free-form tags/metadata the model extracted, used by the index. */
  metadata: Record<string, unknown>;
  /**
   * The classifier could NOT confidently classify (model down / bad output → fail-safe SEALED), so the
   * submission MUST be confirmed regardless of the policy threshold. A confident classification sets this
   * `false`; the ingestion QUARANTINE policy (`confirmAtOrBelow` + per-Emissary autofile trust) is applied
   * downstream in `handleSubmission`, not here — the classifier's job is the sensitivity label, not policy.
   */
  needsHumanConfirmation: boolean;
}

export interface Classifier {
  classify(input: { kind: string; text: string }): Promise<Classification>;
}

/** Fail-safe classifier: returns the quarantine default and flags for human review. */
export class QuarantineClassifier implements Classifier {
  async classify(_input: { kind: string; text: string }): Promise<Classification> {
    return { sensitivity: DEFAULT_SENSITIVITY, metadata: {}, needsHumanConfirmation: true };
  }
}

const LABEL_TO_SENSITIVITY: Record<string, Sensitivity> = {
  PUBLIC: Sensitivity.PUBLIC,
  LOW: Sensitivity.LOW,
  MEDIUM: Sensitivity.MEDIUM,
  HIGH: Sensitivity.HIGH,
  SEALED: Sensitivity.SEALED,
};

const FORMAT_SCHEMA = {
  type: 'object',
  properties: {
    sensitivity: { type: 'string', enum: ['PUBLIC', 'LOW', 'MEDIUM', 'HIGH', 'SEALED'] },
    // BOUND the array + string. An unbounded `tags` array is a grammar branch that never has to
    // terminate; paired with greedy decoding (temp 0, no repeat penalty) the model degenerates into a
    // repetition loop INSIDE it ("Usage Usage Usage …") and runs to the Ollama server timeout. Caps make
    // the JSON grammar terminate. (Found via a classifier runaway — Aegis, #58 review.)
    tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    reason: { type: 'string', maxLength: 400 },
  },
  required: ['sensitivity', 'tags', 'reason'],
} as const;

const SYSTEM_PROMPT = `You are the privacy classifier for a personal data vault. Assign a sensitivity
level to an artefact based on how damaging its disclosure would be to the person.

Levels:
- PUBLIC: already public or trivially shareable.
- LOW: low-sensitivity personal info (e.g. a casual public check-in, a preference).
- MEDIUM: ordinary private info (e.g. routine location, everyday messages).
- HIGH: sensitive info — financial, health, legal, credentials, or government identifiers.
- SEALED: extremely sensitive — exposure could cause serious harm (secrets, intimate, safety-critical).

When uncertain, choose the HIGHER sensitivity — failing toward protection. Respond only with the JSON
object.`;

const MAX_TEXT = 4000;

/**
 * Local-only classifier backed by an Ollama model (default qwen3:8b). Uses Ollama structured
 * outputs to get a deterministic JSON label. Any failure — model down, bad JSON, unknown label —
 * fails safe to the quarantine default (SEALED).
 */
export class OllamaClassifier implements Classifier {
  constructor(
    private readonly url: string,
    private readonly model: string,
  ) {}

  async classify(input: { kind: string; text: string }): Promise<Classification> {
    try {
      const res = await fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          ...noThink(this.model), // reasoning models burn <think> tokens before the label; skip it (the /no_think prompt idiom is inert)
          // temp 0 is greedy; Ollama's default `repeat_penalty` is 1.0 (no penalty) and there is no output
          // cap — the textbook runaway-repetition recipe. `repeat_penalty` breaks the loop, `num_predict`
          // bounds the worst case (256 ≫ this schema's max output), and the schema caps above make valid
          // output terminate. All three together: the demo corpus went from >20 min (4 silent timeouts) to
          // ~12.5s, 8/8 genuinely classified (Aegis, #58 review).
          options: { temperature: 0, num_predict: 256, repeat_penalty: 1.1 },
          format: FORMAT_SCHEMA,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `kind=${input.kind}\ntext=${input.text.slice(0, MAX_TEXT)}` },
          ],
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);

      const data = (await res.json()) as { message?: { content?: string } };
      const parsed = JSON.parse(data.message?.content ?? '{}') as {
        sensitivity?: string;
        tags?: string[];
        reason?: string;
      };
      const sensitivity = LABEL_TO_SENSITIVITY[parsed.sensitivity ?? ''];
      if (sensitivity === undefined) throw new Error(`unknown label: ${parsed.sensitivity}`);

      return {
        sensitivity,
        metadata: { tags: parsed.tags ?? [], reason: parsed.reason ?? '', model: this.model },
        needsHumanConfirmation: false, // classified confidently; quarantine policy is applied in handleSubmission
      };
    } catch (err) {
      // Fail safe: quarantine and flag for review.
      const reason = err instanceof Error ? err.message : String(err);
      // Make the fail-safe VISIBLE. A silent SEALED is indistinguishable from a real SEALED verdict, and this
      // path is on EVERY submit — so a model outage or a bad-output runaway silently quarantines content while
      // reporting success. Log when we fall back (kind + model + reason, never the artefact text) so an
      // operator can tell "the model failed" from "this was truly sensitive". (Aegis, #58 review.)
      process.stderr.write(`[classifier] FAIL-SAFE → ${DEFAULT_SENSITIVITY} (kind=${input.kind}, model=${this.model}): ${reason}\n`);
      return {
        sensitivity: DEFAULT_SENSITIVITY,
        metadata: { error: reason, model: this.model },
        needsHumanConfirmation: true,
      };
    }
  }
}

/** Select the classifier from config: the local model, or the fail-safe quarantine stub. */
export function createClassifier(config: HearthholdConfig = loadConfig()): Classifier {
  if (config.classifierMode === 'quarantine') return new QuarantineClassifier();
  return new OllamaClassifier(config.ollamaUrl, config.classifierModel);
}
