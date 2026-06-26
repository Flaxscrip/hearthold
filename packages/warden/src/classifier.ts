import {
  Sensitivity,
  DEFAULT_SENSITIVITY,
  relaxNeedsConfirmation,
  loadConfig,
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
  /** Whether relaxing below the quarantine default needs human confirmation. */
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
    tags: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
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
object. /no_think`;

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
          options: { temperature: 0 },
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
        needsHumanConfirmation: relaxNeedsConfirmation(sensitivity),
      };
    } catch (err) {
      // Fail safe: quarantine and flag for review.
      return {
        sensitivity: DEFAULT_SENSITIVITY,
        metadata: {
          error: err instanceof Error ? err.message : String(err),
          model: this.model,
        },
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
