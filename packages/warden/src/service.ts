import {
  PROTOCOL_VERSION,
  unsealAsWarden,
  contentId,
  type KeymasterHandle,
  type WitnessSubmission,
  type SubmissionReceipt,
} from '@hearthold/core';

import { createClassifier, type Classifier } from './classifier.js';
import { VaultStore, type Artefact } from './store.js';

/**
 * The Warden's submission handler: unseal a witness payload locally, classify its sensitivity,
 * store the (still-encrypted) artefact, and return a receipt. Invoked synchronously per HTTP POST.
 */
export class WardenService {
  private readonly store: VaultStore;
  private readonly classifier: Classifier;

  constructor(
    private readonly warden: KeymasterHandle,
    classifier: Classifier = createClassifier(),
  ) {
    this.store = new VaultStore(warden.dataFolder);
    this.classifier = classifier;
  }

  /** Process one witness submission. `witnessDid` is the authenticated session subject. */
  async handleSubmission(
    submission: WitnessSubmission,
    witnessDid: string,
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
      metadata: { ...classification.metadata, witness: witnessDid },
    };
    await this.store.put(artefact);

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
