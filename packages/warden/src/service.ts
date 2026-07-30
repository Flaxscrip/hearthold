import {
  PROTOCOL_VERSION,
  unsealAsWarden,
  contentId,
  Sensitivity,
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
    /**
     * Ingestion policy for this submission. `confirmAtOrBelow` (default SEALED = quarantine everything) is
     * the sensitivity floor at/below which the item is quarantined born-obsidian; `autofileTrusted` (a
     * per-Emissary trust-registry grant) bypasses that floor for a trusted device. Omitted ⇒ safe default
     * (quarantine all): an Emissary may PROPOSE, only the Sovereign's triage-confirm ADMITS.
     */
    policy?: { autofileTrusted?: boolean; confirmAtOrBelow?: Sensitivity },
  ): Promise<SubmissionReceipt> {
    // Decrypt locally for classification only — the stored artefact stays sealed at rest.
    const plaintext = await unsealAsWarden(this.warden, submission.ciphertext);
    const classification = await this.classifier.classify({
      kind: submission.kind,
      text: plaintext,
    });

    // The admission gate. Quarantine (needs the Sovereign's confirm) when the classifier was uncertain, OR
    // when the sensitivity is at/below the policy floor AND this Emissary is not autofile-trusted. A
    // quarantined item is stored but NOT indexed → inert (not recall/KB-searchable) until confirmed.
    const confirmAtOrBelow = policy?.confirmAtOrBelow ?? Sensitivity.SEALED;
    const mustConfirm =
      classification.needsHumanConfirmation ||
      (!policy?.autofileTrusted && classification.sensitivity <= confirmAtOrBelow);

    const storedAt = new Date().toISOString();
    const id = contentId(submission.ciphertext, this.warden.cipher);
    const artefact: Artefact = {
      id,
      kind: submission.kind,
      observedAt: submission.observedAt,
      storedAt,
      sensitivity: classification.sensitivity,
      ciphertext: submission.ciphertext,
      metadata: { ...classification.metadata, witness: emissaryDid, needsHumanConfirmation: mustConfirm },
      // A personal submission is the member's own; scope 'private'. `owner` scopes the visible set (Phase 3).
      ...(owner ? { owner, scope: 'private' as const } : {}),
    };
    await this.store.put(artefact);

    // Inert-until-confirmed: index for recall ONLY when NOT quarantined. A born-obsidian item is not
    // searchable via recall/KB until the Sovereign admits it (the recall index is what `/api/recall` reads),
    // so an Emissary's authority to submit never becomes authority to inject usable corpus. On triage-confirm
    // the control plane re-indexes it (see `indexArtefact`).
    if (!mustConfirm) await this.indexArtefact(artefact, plaintext);

    return {
      type: 'hearthold/submission-receipt',
      version: PROTOCOL_VERSION,
      artefactId: id,
      assignedSensitivity: artefact.sensitivity,
      storedAt,
    };
  }

  /**
   * Embed + add an artefact to the recall index (metadata only; no plaintext retained). Reused by
   * `handleSubmission` (for auto-admitted items) and by triage-confirm (to admit a previously-quarantined
   * item). Fail-open — an embedding failure must never break the calling path. `plaintext`, if the caller
   * already has it (submission path), avoids a re-unseal; otherwise it is unsealed from the artefact.
   */
  async indexArtefact(artefact: Artefact, plaintext?: string): Promise<void> {
    if (!this.embedder || !this.index) return;
    try {
      const text = plaintext ?? (await unsealAsWarden(this.warden, artefact.ciphertext));
      const embedding = await this.embedder.embed(text);
      await this.index.put({
        artefactId: artefact.id,
        kind: artefact.kind,
        observedAt: artefact.observedAt,
        sensitivity: artefact.sensitivity,
        embedding,
        ...(artefact.owner ? { owner: artefact.owner } : {}),
        ...(artefact.scope ? { scope: artefact.scope } : {}),
      });
    } catch {
      /* recall index is best-effort; the calling path still succeeds */
    }
  }

  /** List stored artefacts (metadata only; payloads remain encrypted). */
  async listArtefacts(): Promise<Artefact[]> {
    return this.store.list();
  }
}
