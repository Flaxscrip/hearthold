import {
  PROTOCOL_VERSION,
  unsealAsWarden,
  contentId,
  Sensitivity,
  DEFAULT_SENSITIVITY,
  type KeymasterHandle,
  type WitnessSubmission,
  type SubmissionReceipt,
  type Embedder,
} from '@hearthold/core';

import { createClassifier, type Classifier, type Classification } from './classifier.js';
import type { VisionCaptioner } from './vision.js';
import { VaultStore, type Artefact } from './store.js';
import { IndexStore } from './index-store.js';
import { resolveImageBytes } from './image-asset.js';

/**
 * The Warden's submission handler: unseal a witness payload locally, classify its sensitivity,
 * store the (still-encrypted) artefact, and return a receipt. Invoked synchronously per HTTP POST.
 */
export class WardenService {
  private readonly store: VaultStore;
  private readonly classifier: Classifier;
  private readonly index?: IndexStore;
  private readonly embedder?: Embedder;
  private readonly captioner?: VisionCaptioner;

  constructor(
    private readonly warden: KeymasterHandle,
    classifier: Classifier = createClassifier(),
    /** When supplied, each submission is embedded + added to the recall index (metadata only). */
    embedder?: Embedder,
    /** When supplied, an `image` submission is captioned locally before classification (reuses the pipeline). */
    captioner?: VisionCaptioner,
  ) {
    this.store = new VaultStore(warden.dataFolder);
    this.classifier = classifier;
    this.captioner = captioner;
    if (embedder) {
      this.embedder = embedder;
      this.index = new IndexStore(warden.dataFolder);
    }
  }

  /**
   * Resolve an `image` submission's bytes for captioning. The sealed payload is one of:
   *   - `{ assetDid }` — a native Archon image asset (bytes in the node's IPFS); we `getImage` it back
   *     (the idiomatic transport — no base64 in DIDComm). PREFERRED.
   *   - `{ image | attachment: { bytesB64, mediaType? } }` — inline base64 (a direct/test submission).
   * Returns the base64 + media type + the asset DID (if any, for provenance), or null on ANY failure (bad
   * payload, unresolvable asset) so the caller fails CLOSED to SEALED — a missing image quarantines, never leaks.
   */
  private imageBytes(plaintext: string): Promise<{ bytesB64: string; mediaType?: string; assetDid?: string } | null> {
    // Shared with card-face hydration (face.ts) — the same asset→bytes resolution the keyless browser can't do.
    return resolveImageBytes(this.warden, plaintext);
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
    // `image` submissions are captioned by the local vision model first; the CAPTION is then classified,
    // embedded, and shown — images inherit the whole pipeline with no parallel path. `embedText` is what the
    // recall index embeds (the caption for images, the payload text otherwise). A vision failure fails CLOSED.
    let classification: Classification;
    let embedText = plaintext;
    let imageDescription: { description: string; tags: string[] } | undefined;
    let imageAssetDid: string | undefined;
    if (submission.kind === 'image') {
      const src = await this.imageBytes(plaintext);
      const cap = src && this.captioner ? await this.captioner.caption({ bytesB64: src.bytesB64, mediaType: src.mediaType }) : null;
      if (!cap) {
        classification = { sensitivity: DEFAULT_SENSITIVITY, metadata: { visionError: 'no caption (vision model absent/errored, or unresolvable image)' }, needsHumanConfirmation: true };
      } else {
        imageDescription = cap;
        imageAssetDid = src?.assetDid;
        classification = await this.classifier.classify({ kind: submission.kind, text: cap.description });
        embedText = cap.description;
      }
    } else {
      classification = await this.classifier.classify({ kind: submission.kind, text: plaintext });
    }

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
      metadata: {
        ...classification.metadata,
        witness: emissaryDid,
        needsHumanConfirmation: mustConfirm,
        // The vision caption is the image's recallable/face text + tags; the bytes live in the sealed payload
        // OR (preferred) a native image asset — `assetDid` links the artefact to that content-addressed object.
        ...(imageDescription ? { description: imageDescription.description, tags: imageDescription.tags } : {}),
        ...(imageAssetDid ? { assetDid: imageAssetDid } : {}),
      },
      // A personal submission is the member's own; scope 'private'. `owner` scopes the visible set (Phase 3).
      ...(owner ? { owner, scope: 'private' as const } : {}),
    };
    await this.store.put(artefact);

    // Inert-until-confirmed: index for recall ONLY when NOT quarantined. A born-obsidian item is not
    // searchable via recall/KB until the Sovereign admits it (the recall index is what `/api/recall` reads),
    // so an Emissary's authority to submit never becomes authority to inject usable corpus. On triage-confirm
    // the control plane re-indexes it (see `indexArtefact`). For images we embed the CAPTION, never the bytes.
    if (!mustConfirm) await this.indexArtefact(artefact, embedText);

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
      // Prefer the caller's text; else the stored caption (images — never embed base64 bytes); else the
      // unsealed payload (documents). An image with no caption has nothing to embed → skip.
      const description = typeof artefact.metadata?.description === 'string' ? artefact.metadata.description : undefined;
      const text = plaintext ?? description ?? (artefact.kind === 'image' ? undefined : await unsealAsWarden(this.warden, artefact.ciphertext));
      if (!text) return;
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

  /** The stable artefact id for a submission — the content hash of its ciphertext, known WITHOUT decrypting
   *  or captioning. Lets the handler ack "received & queued" immediately, before the slow processing runs. */
  artefactIdFor(submission: WitnessSubmission): string {
    return contentId(submission.ciphertext, this.warden.cipher);
  }

  /** List stored artefacts (metadata only; payloads remain encrypted). */
  async listArtefacts(): Promise<Artefact[]> {
    return this.store.list();
  }
}
