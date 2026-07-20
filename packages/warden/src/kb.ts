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
  sealToKey,
  contentId,
  PROTOCOL_VERSION,
  type KeymasterHandle,
  type HearthholdConfig,
  type TrustEvaluator,
  type CipherPublicJwk,
  meetsAssurance,
  type Transport,
  type RulesetSigner,
  type SignedRuleset,
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
import type { PartitionKeyLookup } from './recall.js';
import type { PartitionStore } from './partition-store.js';
import type { SessionKeyStore } from './session-keys.js';
import { unlockSessionPartitions, type RewrapChannel } from './rewrap.js';

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
  /** KB Spaces: this space grants each member a private partition (private DB). */
  memberPartitions?: boolean;
  /** Where a scope-less contribution lands. Default 'shared'. */
  defaultScope?: 'shared' | 'private';
  /** The Warden-side store of per-member private partitions (present when `memberPartitions`). */
  partitions?: PartitionStore;
  /**
   * Read-guest keys (Phase 6): transient partition private keys held for a live session so the Warden can
   * RAG the member's OWN member-key-sealed private content. Populated at login via `rewrapChannel`, keyed
   * by session token, zeroized when the session ends. Absent ⇒ no member-key reads (the pre-cutover path).
   */
  sessionKeys?: SessionKeyStore;
  /** The channel the login rewrap round-trip rides (the Warden↔member Signet transport). */
  rewrapChannel?: RewrapChannel;
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
 * A `RulesetSigner` backed by DIDComm: the Warden asks the governing Sovereign's Signet to **sign** a
 * policy change (a fresh proof-of-human at the Signet). The signature is the Sovereign's, and readers
 * pin `governor` — so a compromised Warden cannot forge policy. Returns null on decline / timeout.
 */
export function makeDidcommRulesetSigner(transport: Transport, governor: string, timeoutMs = 170_000): RulesetSigner {
  return {
    governor,
    async sign(ruleset, summary) {
      try {
        const reply = await transport.request(
          governor,
          { type: 'hearthold/ruleset-sign-request', version: PROTOCOL_VERSION, ruleset, summary },
          { timeoutMs },
        );
        if (reply.type === 'hearthold/ruleset-sign-response' && reply.approved) return reply.signed as SignedRuleset;
        return null;
      } catch {
        return null; // unreachable Signet / timeout ⇒ not signed (fail closed)
      }
    },
  };
}

/**
 * Ask the SUBJECT member's Signet to acknowledge a governor-signed guardianship edge (Phase 5). The ack
 * is the member's own co-signature over the base Ruleset — the amendment rule's member half. Routed to
 * the member's own device and gated by their fresh proof-of-human (never the governor's). Returns the
 * `memberAck` proof, or null on decline / timeout (fail closed — no ack ⇒ the edge authorizes nothing).
 */
export function makeDidcommMemberAcker(
  transport: Transport,
  member: string,
  timeoutMs = 170_000,
): (ruleset: SignedRuleset, summary: string) => Promise<unknown | null> {
  return async (ruleset, summary) => {
    try {
      const reply = await transport.request(
        member,
        { type: 'hearthold/member-ack-request', version: PROTOCOL_VERSION, ruleset, summary },
        { timeoutMs },
      );
      if (reply.type === 'hearthold/member-ack-response' && reply.approved) return reply.memberAck;
      return null;
    } catch {
      return null; // unreachable Signet / timeout ⇒ not acknowledged (fail closed)
    }
  };
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
    // Read-guest unlock (Phase 6): if this space grants member partitions and a rewrap channel is wired,
    // ask the member's Signet to rewrap their OWN partition keys to a Warden ephemeral key for this
    // session (the member authorizes with their own proof-of-human). Best-effort: a decline / unreachable
    // Signet / a member with no member-key partitions unlocks 0 and login still succeeds — the read side
    // simply falls back to whatever the artefact is sealed to (Warden-sealed content is unaffected).
    if (this.opts.memberPartitions && this.opts.sessionKeys && this.opts.rewrapChannel) {
      try {
        await unlockSessionPartitions(this.warden, this.config, this.opts.rewrapChannel, res.responder, token, this.opts.sessionKeys);
      } catch {
        /* rewrap declined / Signet unreachable → 0 unlocked; login is not blocked on it */
      }
    }
    return {
      type: 'hearthold/kb-session',
      version: PROTOCOL_VERSION,
      token,
      did: res.responder,
      expiresAt: new Date(exp).toISOString(),
      memberPartitions: this.opts.memberPartitions ?? false,
      defaultScope: this.opts.defaultScope ?? 'shared',
    };
  }

  /** Serve a session-authenticated request (the token stands in for a per-request signature). */
  async serveWithSession(req: KbSessionRequestMessage): Promise<KbResultMessage> {
    if (req.kbId !== this.opts.kbId) return kbErr('request is for a different KB');
    const s = this.sessions.get(req.token);
    if (!s) return kbErr('unknown session — please log in');
    if (Date.now() > s.exp) {
      this.sessions.delete(req.token);
      this.opts.sessionKeys?.zeroize(req.token); // read-guest keys die with the session, not at some later GC
      return kbErr('session expired — please log in again');
    }
    return this.execute(s.did, req, req.token);
  }

  /** The member's own private partition in this space, if provisioned + they are still its member. Carries
   *  the partition PUBLIC key (write-host): a private write seals to it so the Warden can't read at rest. */
  private async ownPartition(did: string): Promise<{ id: string; partitionPub?: CipherPublicJwk } | null> {
    if (!this.opts.partitions) return null;
    const p = await this.opts.partitions.get(this.opts.kbId, did);
    if (!p || p.location.kind !== 'local') return null; // Phase 1: local partitions only
    const member = await this.warden.keymaster.testGroup(p.group, did).catch(() => false);
    return member ? { id: p.id, partitionPub: p.partitionPub } : null;
  }

  /** Run the assurance step-up if the space's policy requires more than factor1 for `action`. */
  private async clearAssurance(did: string, action: 'read' | 'write', summary: string): Promise<string | null> {
    const authz = await this.opts.registry.authorize({ entity_id: did, action, resource: this.opts.kbId });
    const required = authz.requiredAssurance ?? 'factor1';
    if (meetsAssurance('factor1', required)) return null;
    if (!this.opts.approver) return `${action} requires ${required}, but no step-up channel is configured`;
    const approved = await this.opts.approver.requestActionApproval({ member: did, action, resource: this.opts.kbId, summary });
    return approved ? null : `${action} was not authorized by the Sovereign (${required} step-up declined)`;
  }

  /** Seal + classify + index a contribution into partition `kb`. When `sealTo` (a member partition's
   *  public key) is given, the payload is sealed to it (write-host: the Warden cannot open it at rest, and
   *  the artefact is marked `sealedTo` so recall opens it with the member's session-rewrapped key); else it
   *  is sealed to the Warden as before. Classification runs on the plaintext in memory, before sealing. */
  private async storeContribution(did: string, kind: string, text: string, kb: string, sealTo?: CipherPublicJwk): Promise<KbResultMessage> {
    const payload = JSON.stringify({ text });
    const ciphertext = sealTo ? sealToKey(this.warden.cipher, sealTo, payload) : await sealForWarden(this.warden, this.opts.wardenDid, payload);
    const classification = await createClassifier(this.config).classify({ kind, text });
    const id = contentId(ciphertext, this.warden.cipher);
    const artefact: Artefact = {
      id,
      kind: kind as Artefact['kind'],
      observedAt: new Date().toISOString(),
      storedAt: new Date().toISOString(),
      sensitivity: classification.sensitivity,
      ciphertext,
      ...(sealTo ? { sealedTo: { partition: kb } } : {}),
      metadata: { ...classification.metadata, kb, contributor: did },
    };
    await this.store.put(artefact);
    // Index (embed) so recall can find it. NON-SILENT: if the embedder is down/overloaded the artefact
    // is still stored, but we surface it — the caller learns via `indexed:false`, the operator sees a
    // warning, and `warden kb-reindex` backfills it later. (Was a silent catch that hid the drop.)
    let indexed = false;
    try {
      const embedding = await this.embedder.embed(text);
      await this.index.put({ artefactId: id, kind: artefact.kind, observedAt: artefact.observedAt, sensitivity: artefact.sensitivity, embedding, kb });
      indexed = true;
    } catch (e) {
      process.stderr.write(
        `[kb] WARNING: stored ${id.slice(0, 12)}… in "${kb}" but indexing FAILED (${e instanceof Error ? e.message : String(e)}) — ` +
          `NOT searchable until \`warden kb-reindex --kb ${kb}\`\n`,
      );
    }
    return { type: 'hearthold/kb-result', version: PROTOCOL_VERSION, action: 'update', artefactId: id, indexed };
  }

  /**
   * Authorize the DID (from the authenticated session — never client input), then serve. A query unions
   * the member's **visible set** (shared partition + their own private partition); an update targets one
   * partition by `scope` (default per space). See docs/kb-spaces.md.
   */
  private async execute(
    did: string,
    req: { action: 'query' | 'update'; query?: string; k?: number; kind?: string; text?: string; scope?: 'shared' | 'private' },
    sessionToken?: string,
  ): Promise<KbResultMessage> {
    const own = await this.ownPartition(did);

    if (req.action === 'query') {
      // Visible set = the shared partition (if a member) ∪ the caller's own private partition. Computed
      // from the authenticated DID, NEVER from the request — a member can't ask to read another's data.
      const sharedRead = (await this.opts.registry.authorize({ entity_id: did, action: 'read', resource: this.opts.kbId })).authorized;
      const visible: string[] = [];
      if (sharedRead) visible.push(this.opts.kbId);
      if (own) visible.push(own.id);
      if (visible.length === 0) return kbErr('not authorized to read this KB');
      if (!req.query) return kbErr('query is required');
      const stepUp = await this.clearAssurance(did, 'read', `read on ${this.opts.kbId}`);
      if (stepUp) return kbErr(stepUp);
      // INVARIANT II — no query attribution retained. The query and `did` are read in memory only to
      // answer; nothing about who-asked-what-when is persisted. Do not add query/requester logging here.
      // Read-guest key lookup (Phase 6): the caller's own member-key partition content is opened with the
      // key their session rewrapped at login; shared/Warden-sealed content needs none. Bound to THIS
      // session token, so a query can only reach the partitions this member unlocked (never another's).
      const keyFor: PartitionKeyLookup | undefined =
        sessionToken && this.opts.sessionKeys ? (pid) => this.opts.sessionKeys?.get(sessionToken, pid) : undefined;
      const result = await RecallService.forWarden(this.warden, this.config, keyFor).recall(req.query, { k: req.k, kb: visible });
      // Label each citation by partition so the portal can show where an answer came from.
      const citations = result.citations.map((c) => ({
        artefactId: c.artefactId,
        kind: c.kind,
        observedAt: c.observedAt,
        score: c.score,
        scope: (c.kb === own?.id ? 'private' : c.kb === this.opts.kbId ? 'shared' : undefined) as 'shared' | 'private' | undefined,
      }));
      return { type: 'hearthold/kb-result', version: PROTOCOL_VERSION, action: 'query', answer: result.answer, citations };
    }

    // update — resolve the target partition by scope.
    if (!req.kind || !req.text) return kbErr('kind and text are required for an update');
    const scope = req.scope ?? this.opts.defaultScope ?? 'shared';
    if (scope === 'private') {
      // A member's own private partition — their private DB. INVARIANT I is preserved: private and
      // shared never merge without an explicit promotion; this write stays in the owner's partition.
      if (!own) return kbErr('no private partition for you on this KB (the space may not grant member partitions)');
      const stepUp = await this.clearAssurance(did, 'write', `contribute (private) to ${this.opts.kbId}: “${req.text.slice(0, 80)}”`);
      if (stepUp) return kbErr(stepUp);
      // Write-host: seal to the partition's PUBLIC key when the partition carries one (member-key) — the
      // Warden writes it but cannot read at rest. Legacy partitions (no pub) stay Warden-sealed.
      return this.storeContribution(did, req.kind, req.text, own.id, own.partitionPub);
    }
    // shared partition — INVARIANT I: shared knowledge, contributor-attributed; not a personal vault.
    const sharedWrite = (await this.opts.registry.authorize({ entity_id: did, action: 'write', resource: this.opts.kbId })).authorized;
    if (!sharedWrite) return kbErr('not authorized to write this KB');
    const stepUp = await this.clearAssurance(did, 'write', `contribute to ${this.opts.kbId}: “${req.text.slice(0, 80)}”`);
    if (stepUp) return kbErr(stepUp);
    return this.storeContribution(did, req.kind, req.text, this.opts.kbId);
  }
}

const kbErr = (reason: string): KbResultMessage => ({ type: 'hearthold/kb-error', version: PROTOCOL_VERSION, reason });
