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
 *
 * Two PVM invariants govern the KB (see docs/knowledge-portal.md):
 *   I.  guild brain ≠ personal vault — the KB holds *shared* knowledge, never a member's 7th Capital;
 *       a personal Warden holds the 7th Capital. These must never merge.
 *   II. no query attribution retained — the query + requester are read in memory only; who-asked-what-
 *       when is never persisted (query logging off by default), preserving the Reconstruction Ceiling.
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
  meetsAssurance,
  type Transport,
  type SignedKbRequest,
  type KbChallengeMessage,
  type KbResultMessage,
  type KbSessionMessage,
  type KbSessionRequestMessage,
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
  /** Nonce lifetime (per-request signature path); a challenge unused past this is rejected. */
  nonceTtlMs?: number;
  /** Web-login session lifetime (default 30 min). */
  sessionTtlMs?: number;
  /** Out-of-band step-up: asks the member's Signet to authorize a factor2 action, when policy demands it. */
  approver?: KbActionApprover;
}

/**
 * Steps up a factor1 session to factor2 by asking the member — **directly, out-of-band** — to authorize
 * an action. The Mage is deliberately not on this channel, so it can neither forge nor replay the
 * approval (the fool-proof second factor for high-stakes actions / AI-agent authorization).
 */
export interface KbActionApprover {
  requestActionApproval(req: {
    member: string;
    action: string;
    resource: string;
    summary: string;
  }): Promise<boolean>;
}

/**
 * A KbActionApprover backed by DIDComm: the Warden asks the member's Signet **directly** to authorize
 * the action. The Mage is not on this channel. Times out (deny) if the Signet doesn't answer.
 */
export function makeDidcommActionApprover(transport: Transport, timeoutMs = 170_000): KbActionApprover {
  return {
    async requestActionApproval(req) {
      try {
        const reply = await transport.request(
          req.member,
          {
            type: 'hearthold/kb-approval-request',
            version: PROTOCOL_VERSION,
            member: req.member,
            action: req.action,
            resource: req.resource,
            summary: req.summary,
          },
          { timeoutMs },
        );
        return reply.type === 'hearthold/kb-approval-response' && reply.approved === true;
      } catch {
        return false; // unreachable Signet or timeout ⇒ not approved (fail closed)
      }
    },
  };
}

export class KbService {
  private readonly store: VaultStore;
  private readonly index: IndexStore;
  private readonly embedder: OllamaEmbedder;
  private readonly nonces = new Map<string, number>(); // nonce → expiry (signed path)
  private readonly sessions = new Map<string, { did: string; exp: number }>(); // token → {did, expiry} (web login)

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

  /**
   * Per-request signature path (CLI / machine clients): authenticate by the requester's own signature
   * over our nonce, then serve. The relaying Mage can't forge it.
   */
  async serve(signed: SignedKbRequest): Promise<KbResultMessage> {
    if (signed?.kbId !== this.opts.kbId) return kbErr('request is for a different KB');
    const auth = await verifyKbRequestSignature(this.warden, signed);
    if (!auth.ok) return kbErr(`authentication failed: ${auth.reason}`);
    if (!signed.nonce || !this.consumeNonce(signed.nonce)) return kbErr('stale or unknown challenge nonce');
    return this.execute(signed.requester, signed);
  }

  // ── Challenge/response login + sessions (web path; keys stay in the member's wallet / the Signet) ──

  /** Begin login: issue an Archon challenge embedding the Mage's public callback. Returns its DID (→ QR). */
  async startLogin(kbId: string, callback: string): Promise<string> {
    if (kbId !== this.opts.kbId) throw new Error('login is for a different KB');
    const createChallenge = this.warden.keymaster.createChallenge.bind(this.warden.keymaster) as (
      challenge?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<string>;
    // A pure authentication challenge — a callback, no credential requirements. `createResponse` on the
    // member's wallet proves DID control; the callback tells the wallet where to POST the response.
    return createChallenge({ callback, kbId }, { registry: this.config.registry });
  }

  /** Complete login: verify the wallet's response, then mint a short-lived session bound to the DID. */
  async completeLogin(responseDID: string): Promise<KbSessionMessage | KbResultMessage> {
    type VerifyResult = { match?: boolean; responder?: string };
    const verifyResponse = this.warden.keymaster.verifyResponse.bind(this.warden.keymaster) as (
      r: string,
      o?: Record<string, unknown>,
    ) => Promise<VerifyResult>;
    const res: VerifyResult = await verifyResponse(responseDID).catch(() => ({ match: false }));
    if (!res.match || !res.responder) return kbErr('login response did not verify');
    const token = randomBytes(24).toString('hex');
    const exp = Date.now() + (this.opts.sessionTtlMs ?? 30 * 60_000);
    this.sessions.set(token, { did: res.responder, exp });
    return { type: 'hearthold/kb-session', version: PROTOCOL_VERSION, token, did: res.responder, expiresAt: new Date(exp).toISOString() };
  }

  /** Serve a session-authenticated request (the token stands in for a per-request signature). */
  async serveWithSession(req: KbSessionRequestMessage): Promise<KbResultMessage> {
    if (req.kbId !== this.opts.kbId) return kbErr('request is for a different KB');
    const s = this.sessions.get(req.token);
    if (!s) return kbErr('unknown session — please log in');
    if (Date.now() > s.exp) {
      this.sessions.delete(req.token);
      return kbErr('session expired — please log in again');
    }
    return this.execute(s.did, req);
  }

  /** Shared: authorize the DID for the action, then query (recall) or update (seal+classify+index). */
  private async execute(
    did: string,
    req: { action: 'query' | 'update'; query?: string; k?: number; kind?: string; text?: string },
  ): Promise<KbResultMessage> {
    const action = req.action === 'update' ? 'write' : 'read';
    const authz = await this.opts.registry.authorize({ entity_id: did, action, resource: this.opts.kbId });
    if (!authz.authorized) return kbErr(`not authorized to ${action} this KB`);

    // Assurance step-up (factor 2) — governance policy, read from the registry. Both entry paths (a
    // signed request, a web-login session) achieve factor1; if policy requires more, the Warden asks
    // the member out-of-band (direct to their Signet — a channel the Mage is never on) to authorize it.
    const required = authz.requiredAssurance ?? 'factor1';
    if (!meetsAssurance('factor1', required)) {
      if (!this.opts.approver) return kbErr(`${action} requires ${required}, but no step-up channel is configured`);
      const summary =
        req.action === 'update' ? `contribute to ${this.opts.kbId}: “${(req.text ?? '').slice(0, 80)}”` : `${action} on ${this.opts.kbId}`;
      const approved = await this.opts.approver.requestActionApproval({ member: did, action, resource: this.opts.kbId, summary });
      if (!approved) return kbErr(`${action} was not authorized by the Sovereign (${required} step-up declined)`);
    }

    if (req.action === 'query') {
      if (!req.query) return kbErr('query is required');
      // INVARIANT II — no query attribution retained. The query and `did` are read in memory only to
      // answer; nothing about *who asked what, when* is persisted or logged. Retaining it would let the
      // host reconstruct a member's interest graph (PVM Reconstruction Ceiling, R<1). Any future ops
      // metrics MUST be aggregate and non-attributable. Do not add query/requester logging here.
      const result = await RecallService.forWarden(this.warden, this.config).recall(req.query, req.k ? { k: req.k } : {});
      return { type: 'hearthold/kb-result', version: PROTOCOL_VERSION, action: 'query', answer: result.answer, citations: result.citations };
    }

    // update — INVARIANT I: this stores *shared* knowledge into the KB, contributor-attributed. It is
    // not a personal vault; a member's 7th Capital must never be routed here (content discipline is a
    // governance rule — the prove→contribute path is how a consented, derived fact enters the KB).
    if (!req.kind || !req.text) return kbErr('kind and text are required for an update');
    const ciphertext = await sealForWarden(this.warden, this.opts.wardenDid, JSON.stringify({ text: req.text }));
    const classification = await createClassifier(this.config).classify({ kind: req.kind, text: req.text });
    const id = contentId(ciphertext, this.warden.cipher);
    const artefact: Artefact = {
      id,
      kind: req.kind as Artefact['kind'],
      observedAt: new Date().toISOString(),
      storedAt: new Date().toISOString(),
      sensitivity: classification.sensitivity,
      ciphertext,
      metadata: { ...classification.metadata, kb: this.opts.kbId, contributor: did },
    };
    await this.store.put(artefact);
    try {
      const embedding = await this.embedder.embed(req.text);
      await this.index.put({ artefactId: id, kind: artefact.kind, observedAt: artefact.observedAt, sensitivity: artefact.sensitivity, embedding });
    } catch {
      /* index is best-effort */
    }
    return { type: 'hearthold/kb-result', version: PROTOCOL_VERSION, action: 'update', artefactId: id };
  }
}

const kbErr = (reason: string): KbResultMessage => ({ type: 'hearthold/kb-error', version: PROTOCOL_VERSION, reason });
