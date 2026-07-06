/**
 * The Knowledge Base service — a private Warden serving a shared, authorized KB.
 *
 * A public Mage relays a Sovereign's signed request here; this service **authenticates** (the request
 * is signed by the DID it claims, over a fresh Warden nonce — end-to-end, Mage-independent) and
 * **authorizes** (that DID is a KB member — a trust-registry group check), then serves:
 *   - **query** → recall over the KB (the Warden's vault *is* the KB in this increment);
 *   - **update** → seal + classify + store + index, stamped with the contributor's DID.
 *
 * The Warden never faces the public and holds the deciding logic; the Mage only carries.
 */

import { randomBytes } from 'node:crypto';

import {
  verifyKbRequestSignature,
  sealForWarden,
  contentId,
  PROTOCOL_VERSION,
  type KeymasterHandle,
  type HearthholdConfig,
  type TrustEvaluator,
  type SignedKbRequest,
  type KbChallengeMessage,
  type KbResultMessage,
} from '@hearthold/core';

import { createClassifier } from './classifier.js';
import { VaultStore, type Artefact } from './store.js';
import { IndexStore } from './index-store.js';
import { RecallService } from './recall.js';
import { OllamaEmbedder } from './recall.js';

interface KbServiceOptions {
  kbId: string;
  /** The KB Warden's own DID (KB contributions are sealed to it, like vault artefacts). */
  wardenDid: string;
  /** Authorizes `read` (query) / `write` (update) on the KB resource (a GroupTrustRegistry). */
  registry: TrustEvaluator;
  /** Nonce lifetime; a challenge unused past this is rejected. */
  nonceTtlMs?: number;
}

export class KbService {
  private readonly store: VaultStore;
  private readonly index: IndexStore;
  private readonly embedder: OllamaEmbedder;
  private readonly nonces = new Map<string, number>(); // nonce → expiry

  constructor(
    private readonly warden: KeymasterHandle,
    private readonly config: HearthholdConfig,
    private readonly opts: KbServiceOptions,
  ) {
    this.store = new VaultStore(warden.dataFolder);
    this.index = new IndexStore(warden.dataFolder);
    this.embedder = new OllamaEmbedder(config.ollamaUrl, config.embeddingModel);
  }

  /** Issue a fresh single-use nonce the Sovereign must sign into its next request. */
  challenge(): KbChallengeMessage {
    const nonce = randomBytes(18).toString('hex');
    this.nonces.set(nonce, Date.now() + (this.opts.nonceTtlMs ?? 120_000));
    return { type: 'hearthold/kb-challenge', version: PROTOCOL_VERSION, nonce };
  }

  private consumeNonce(nonce: string): boolean {
    const exp = this.nonces.get(nonce);
    if (exp === undefined) return false; // unknown or already used
    this.nonces.delete(nonce); // single-use
    return Date.now() <= exp;
  }

  /** Authenticate + authorize + serve a signed KB request. */
  async serve(signed: SignedKbRequest): Promise<KbResultMessage> {
    const err = (reason: string): KbResultMessage => ({ type: 'hearthold/kb-error', version: PROTOCOL_VERSION, reason });

    if (signed?.kbId !== this.opts.kbId) return err('request is for a different KB');

    // 1. Authenticate — the request is signed by the DID it claims (end-to-end; the Mage can't forge).
    const auth = await verifyKbRequestSignature(this.warden, signed);
    if (!auth.ok) return err(`authentication failed: ${auth.reason}`);

    // 2. Freshness — the nonce is one we issued and hasn't been used (anti-replay).
    if (!signed.nonce || !this.consumeNonce(signed.nonce)) return err('stale or unknown challenge nonce');

    // 3. Authorize — this member may read (query) / write (update) the KB.
    const action = signed.action === 'update' ? 'write' : 'read';
    const authz = await this.opts.registry.authorize({ entity_id: signed.requester, action, resource: this.opts.kbId });
    if (!authz.authorized) return err(`not authorized to ${action} this KB`);

    // 4. Serve.
    if (signed.action === 'query') {
      if (!signed.query) return err('query is required');
      const result = await RecallService.forWarden(this.warden, this.config).recall(signed.query, signed.k ? { k: signed.k } : {});
      return {
        type: 'hearthold/kb-result',
        version: PROTOCOL_VERSION,
        action: 'query',
        answer: result.answer,
        citations: result.citations,
      };
    }

    // update
    if (!signed.kind || !signed.text) return err('kind and text are required for an update');
    const ciphertext = await sealForWarden(this.warden, this.opts.wardenDid, JSON.stringify({ text: signed.text }));
    const classification = await createClassifier(this.config).classify({ kind: signed.kind, text: signed.text });
    const id = contentId(ciphertext, this.warden.cipher);
    const artefact: Artefact = {
      id,
      kind: signed.kind as Artefact['kind'],
      observedAt: new Date().toISOString(),
      storedAt: new Date().toISOString(),
      sensitivity: classification.sensitivity,
      ciphertext,
      metadata: { ...classification.metadata, kb: this.opts.kbId, contributor: signed.requester },
    };
    await this.store.put(artefact);
    try {
      const embedding = await this.embedder.embed(signed.text);
      await this.index.put({
        artefactId: id,
        kind: artefact.kind,
        observedAt: artefact.observedAt,
        sensitivity: artefact.sensitivity,
        embedding,
      });
    } catch {
      /* index is best-effort */
    }
    return { type: 'hearthold/kb-result', version: PROTOCOL_VERSION, action: 'update', artefactId: id };
  }
}
