import { Sensitivity, DEFAULT_SENSITIVITY } from '@hearthold/core';

/**
 * Local-only classifier. The Warden's defining invariant is that this runs entirely on hardware
 * the Sovereign controls (e.g. an Ollama model) — no artefact content is ever sent to a cloud
 * service. This module is the seam where that local model is plugged in.
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

/**
 * Placeholder classifier: returns the fail-safe quarantine default and flags for human review.
 * Replace with an Ollama-backed implementation (see docs/PLAN.md open questions).
 */
export class QuarantineClassifier implements Classifier {
  async classify(_input: { kind: string; text: string }): Promise<Classification> {
    return {
      sensitivity: DEFAULT_SENSITIVITY,
      metadata: {},
      needsHumanConfirmation: true,
    };
  }
}

/**
 * Factory: selects the local model backend from config. For now only the quarantine placeholder
 * exists; an `OllamaClassifier` will land in v1 step 4.
 */
export function createClassifier(): Classifier {
  return new QuarantineClassifier();
}
