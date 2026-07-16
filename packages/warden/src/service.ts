import {
  PROTOCOL_VERSION,
  unsealAsWarden,
  contentId,
  type KeymasterHandle,
  type WitnessSubmission,
  type SubmissionReceipt,
  type Embedder,
} from '@hearthold/core';

import { createClassifier, type Classifier } from './classifier.js';
import { VaultStore, type Artefact } from './store.js';
import { IndexStore } from './index-store.js';

/**
 * The Warden's submission handler: unseal a witness payload locally, classify its sensitivity,
 * store the (still-encrypted) artefact, and return a receipt. Invoked synchronously per HTTP POST.
 */
export class WardenService {
  private readonly store: VaultStore;
  private readonly classifier: Classifier;
  private readonly index?: IndexStore;
  private readonly embedder?: Embedder;

  constructor(
    private readonly warden: KeymasterHandle,
    classifier: Classifier = createClassifier(),
    /** When supplied, each submission is embedded + added to the recall index (metadata only). */
    embedder?: Embedder,
  ) {
    this.store = new VaultStore(warden.dataFolder);
    this.classifier = classifier;
    if (embedder) {
      this.embedder = embedder;
      this.index = new IndexStore(warden.dataFolder);
    }
  }

  /**
   * Process one witness submission. `emissaryDid` is the authenticated transport subject (the witness);
   * `owner` is the household member this submission belongs to — its OWNER for visible-set scoping. When
   * omitted (single-Sovereign), the artefact carries no owner and is treated as the configured Sovereign's.
   */
  async handleSubmission(
    submission: WitnessSubmission,
    emissaryDid: string,
    owner?: string,
  ): Promise<SubmissionReceipt> {
    // Decrypt locally for classification only — the stored artefact stays sealed at rest.
    const plaintext = await unsealAsWarden(this.warden, submission.ciphertext);
    const classification = await this.classifier.classify({
      kind: submission.kind,
      text: plaintext,
    });

    const storedAt = new Date().toISOString();
    const id = contentId(submission.ciphertext, this.warden.cipher);
    const artefact: Artefact = {
      id,
      kind: submission.kind,
      observedAt: submission.observedAt,
      storedAt,
      sensitivity: classification.sensitivity,
      ciphertext: submission.ciphertext,
      metadata: { ...classification.metadata, witness: emissaryDid, needsHumanConfirmation: classification.needsHumanConfirmation },
      // A personal submission is the member's own; scope 'private'. `owner` scopes the visible set (Phase 3).
      ...(owner ? { owner, scope: 'private' as const } : {}),
    };
    await this.store.put(artefact);

    // Index for recall (embeddings + metadata only; plaintext is not retained). Fail-open — an
    // embedding failure must never break the submission/store path.
    if (this.embedder && this.index) {
      try {
        const embedding = await this.embedder.embed(plaintext);
        await this.index.put({
          artefactId: id,
          kind: submission.kind,
          observedAt: submission.observedAt,
          sensitivity: artefact.sensitivity,
          embedding,
          ...(owner ? { owner, scope: 'private' as const } : {}),
        });
      } catch {
        /* recall index is best-effort; submission still succeeds */
      }
    }

    return {
      type: 'hearthold/submission-receipt',
      version: PROTOCOL_VERSION,
      artefactId: id,
      assignedSensitivity: artefact.sensitivity,
      storedAt,
    };
  }

  /** List stored artefacts (metadata only; payloads remain encrypted). */
  async listArtefacts(): Promise<Artefact[]> {
    return this.store.list();
  }
}
