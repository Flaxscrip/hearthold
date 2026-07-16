/**
 * `warden control` — the Warden Console's backing daemon.
 *
 * Runs the real Warden: opens its wallet, serves the DIDComm mailbox (store submissions, reply with
 * receipts), and exposes a localhost control API + SSE event stream the browser console drives. Every
 * stored submission is pushed to connected consoles live.
 */

import { randomUUID } from 'node:crypto';

import {
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  DidCommTransport,
  IDENTITY_NAME,
  startControlServer,
  grantAuthorization,
  revokeAuthorization,
  selfSigner,
  AuthzTier,
  Sensitivity,
  FileSpentTxnStore,
  PROTOCOL_VERSION,
  type HearthholdConfig,
  type KeymasterHandle,
  type RequestHandler,
  type SubmissionReceipt,
  type WitnessSubmission,
  type EvidenceRequest,
} from '@hearthold/core';
import {
  SENSITIVITY_NAMES,
  type SensitivityName,
  type VaultItem,
  type WardenSnapshot,
  type WardenStatus,
  type DelegateRequest,
  type ClassifyRequest,
  type RecallRequest,
  type CardFaceRequest,
  type TriageConfirmRequest,
  type MarkCandidate,
  type MarkClaimRequest,
  type ProveRequest,
  type ProofRecord,
  type PresentRequest,
  type KbView,
  type KbGrantRequest,
  type KbPolicyRequest,
} from '@hearthold/control-types';

import { createClassifier } from './classifier.js';
import { WardenService } from './service.js';
import { VaultStore, type Artefact } from './store.js';
import { DelegationStore } from './delegations.js';
import { EvidenceService, type SovereignApprover } from './evidence.js';
import { OllamaEmbedder, RecallService } from './recall.js';
import { makeDidcommActionApprover, makeDidcommRulesetSigner } from './kb.js';
import { hydrateCardFace } from './face.js';
import { triageQueue, confirmTriage } from './triage.js';
import { claimableMarks, claimMark } from './marks.js';
import { buildKbServices, KbConfigStore, setKbAssurance, readKbAssurance, provisionMemberPartition } from './kb-config.js';
import { makeWardenHandler } from './handler.js';
import { ControlSessionStore } from './control-session.js';
import { SessionKeyStore } from './session-keys.js';
import { unlockSessionPartitions, type RewrapChannel } from './rewrap.js';

const sensitivityName = (s: number): SensitivityName => SENSITIVITY_NAMES[s] ?? 'SEALED';

const toVaultItem = (a: Artefact): VaultItem => ({
  id: a.id,
  kind: a.kind,
  sensitivity: a.sensitivity,
  sensitivityName: sensitivityName(a.sensitivity),
  observedAt: a.observedAt,
  ...(a.scope ? { scope: a.scope } : {}),
});

export async function runWardenControl(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  port: number,
): Promise<void> {
  const id = await ensureIdentity(handle, config);
  const store = new VaultStore(handle.dataFolder);
  const delegations = new DelegationStore(handle);
  const kbStore = new KbConfigStore(handle.dataFolder);
  // Control-plane sessions: a member proves DID control at login; the Table rides an opaque bearer token.
  const sessions = new ControlSessionStore(config.sessionTtlMs);
  // The read-guest keys: transient partition keys held only for the session (in memory; zeroized at its end).
  const sessionKeys = new SessionKeyStore();
  const createChallenge = handle.keymaster.createChallenge.bind(handle.keymaster) as (
    c?: Record<string, unknown>,
    o?: Record<string, unknown>,
  ) => Promise<string>;
  const verifyResponse = handle.keymaster.verifyResponse.bind(handle.keymaster) as (
    r: string,
    o?: Record<string, unknown>,
  ) => Promise<{ match?: boolean; responder?: string }>;
  /** The session bearer token off the request header (the Table sends `X-Hearthold-Session`). */
  const sessionToken = (ctx: { req: { headers: Record<string, string | string[] | undefined> } }): string | null => {
    const h = ctx.req.headers['x-hearthold-session'];
    return Array.isArray(h) ? h[0] ?? null : h ?? null;
  };
  // ── The G-grade boundary (Phase 3): every scoped route computes its visible set from the SESSION DID,
  // server-side, never from anything the client sends. The viewer is the authenticated session member, or
  // the configured Sovereign when unauthenticated (single-Sovereign back-compat). Pre-family artefacts
  // (no owner) belong to the Sovereign. An artefact is visible iff the viewer owns it or it is shared.
  const effectiveViewer = (ctx: { req: { headers: Record<string, string | string[] | undefined> } }): string | undefined =>
    sessions.resolve(sessionToken(ctx)) ?? config.sovereignDid;
  const ownerOf = (a: Artefact): string | undefined => a.owner ?? config.sovereignDid;
  const visibleTo = (a: Artefact, viewer: string | undefined): boolean => ownerOf(a) === viewer || a.scope === 'shared';

  const members = async (group: string): Promise<string[]> => {
    const g = (await handle.keymaster.getGroup(group).catch(() => null)) as { members?: string[] } | null;
    return g?.members ?? [];
  };
  // A view of every KB this Warden holds (members = group DIDs; policy = the signed chain).
  const kbList = async (): Promise<KbView[]> => {
    const kbs = await kbStore.list();
    return Promise.all(
      kbs.map(async (kb) => ({
        kbId: kb.kbId,
        readGroup: kb.readGroup,
        writeGroup: kb.writeGroup,
        readers: await members(kb.readGroup),
        writers: await members(kb.writeGroup),
        policy: await readKbAssurance(handle, kb.policyAsset, kb.governorDid),
        governed: !!kb.governorDid,
      })),
    );
  };
  const embedder = config.indexMode === 'ollama' ? new OllamaEmbedder(config.ollamaUrl, config.embeddingModel) : undefined;
  const service = new WardenService(handle, createClassifier(config), embedder);

  const transport = new DidCommTransport(handle, IDENTITY_NAME.warden, config.nodeUrl);
  await transport.ready();

  // Direct Warden↔Signet approval channel for a sensitive disclosure (a forge of MEDIUM+ data). Routes
  // to the SUBJECT MEMBER's own Signet — `req.subjectDid` (Fable amendment 2 / rewrap-spec §4.2: one
  // household ≠ one Signet), falling back to the configured Sovereign for the single-Sovereign case. The
  // step-up timeout is configurable per assurance level (Fable: the hard 180s lapses for a live human tap).
  const approver: SovereignApprover = {
    async requestApproval(req) {
      const target = req.subjectDid ?? config.sovereignDid;
      if (!target) {
        return { type: 'hearthold/approval-response', version: PROTOCOL_VERSION, approved: false, reason: 'no approver configured for this disclosure' };
      }
      const timeoutMs = config.stepUpTimeoutMs[req.requiredLevel >= 2 ? 'factor2' : 'factor1'];
      try {
        const reply = await transport.request(target, req, { timeoutMs });
        if (reply.type === 'hearthold/approval-response') return reply;
        return { type: 'hearthold/approval-response', version: PROTOCOL_VERSION, approved: false, reason: `unexpected reply ${reply.type}` };
      } catch (err) {
        return { type: 'hearthold/approval-response', version: PROTOCOL_VERSION, approved: false, reason: `Signet unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
  const evidenceService = new EvidenceService(handle, config, approver);
  // Forge/present (Sevenfold Divination→Forge→Burn): scroll validity by credentialDid, single-use
  // enforced verifier-side (the holder can't reset it) via the same SpentTxnStore as e2e:scroll-burn.
  const forgeLedger = new Map<string, string | undefined>(); // credentialDid → validUntil (session)
  const spentScrolls = new FileSpentTxnStore(handle.dataFolder);

  const classifierLabel =
    config.classifierMode === 'ollama'
      ? `ollama ${config.classifierModel} @ ${config.ollamaUrl}`
      : 'quarantine (model disabled)';

  const status = async (): Promise<WardenStatus> => ({
    identity: { role: 'warden', name: id.name, did: id.did },
    nodeUrl: config.nodeUrl,
    dataFolder: handle.dataFolder,
    classifier: classifierLabel,
    artefactCount: (await store.list()).length,
    delegationCount: (await delegations.list()).length,
    serving: true,
  });

  const snapshot = async (viewer: string | undefined): Promise<WardenSnapshot> => ({
    status: await status(),
    vault: (await store.list()).filter((a) => visibleTo(a, viewer)).map(toVaultItem),
    delegations: await delegations.list(),
  });

  const server = startControlServer({
    port,
    // SSE audience filtering (Phase 3): resolve each console's viewer DID so a member's events don't reach
    // another member's stream. Falls back to undefined (broadcast-eligible) when unauthenticated.
    resolveSession: (token) => sessions.resolve(token ?? null) ?? undefined,
    routes: {
      'GET /api/status': async (ctx) => ({
        status: { ...(await status()), sessionDid: sessions.resolve(sessionToken(ctx)) ?? undefined },
      }),
      'GET /api/snapshot': async (ctx) => await snapshot(effectiveViewer(ctx)),

      // ── Control-plane session (Phase 2) — proven identity only (no client-asserted DID). The member's
      // wallet/Signet createResponse()s the challenge; keys never leave it. The Table rides the bearer
      // token; every scoped route (Phase 3) computes its visible set from the SESSION DID, server-side.
      'POST /api/login/start': async ({ body }) => {
        const { callback } = (body ?? {}) as { callback?: string };
        const challenge = await createChallenge({ callback, purpose: 'hearthold-control' }, { registry: config.registry });
        return { challenge };
      },
      'POST /api/login/complete': async ({ body }) => {
        const { response } = (body ?? {}) as { response?: string };
        if (!response) throw new Error('response is required');
        const res = await verifyResponse(response).catch(() => ({ match: false } as { match?: boolean; responder?: string }));
        if (!res.match || !res.responder) throw new Error('login response did not verify');
        return { ...sessions.issue(res.responder), did: res.responder };
      },
      'GET /api/whoami': async (ctx) => {
        const token = sessionToken(ctx);
        const did = sessions.resolve(token);
        if (!did) throw new Error('no active session');
        return { did, expiresAt: sessions.expiresAt(token) };
      },
      // Unlock the session member's private partitions for RAG — the read-guest rewrap. Prompts the
      // member's OWN Signet for proof-of-human; the Warden holds the rewrapped keys only for this session.
      'POST /api/session/unlock': async (ctx) => {
        const token = sessionToken(ctx);
        const sessionDid = sessions.resolve(token);
        if (!sessionDid || !token) throw new Error('no session — log in');
        const unlocked = await unlockSessionPartitions(handle, config, transport as unknown as RewrapChannel, sessionDid, token, sessionKeys);
        return { unlocked };
      },
      'POST /api/logout': async (ctx) => {
        const token = sessionToken(ctx);
        const revoked = sessions.revoke(token);
        // Zeroize any read-guest keys the moment the session ends — decryption dies with the session (§4.3).
        if (revoked) sessionKeys.zeroize(revoked);
        return { ok: true, revoked: !!revoked };
      },
      'POST /api/delegate': async ({ body }) => {
        const { emissaryDid } = (body ?? {}) as DelegateRequest;
        if (!emissaryDid) throw new Error('emissaryDid is required');
        const schemaDid = await ensureDelegationSchema(handle);
        const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
        const credentialDid = await issueDelegation(handle, emissaryDid, schemaDid, {
          kinds: ['event', 'location', 'activity', 'browsing', 'document'],
          validUntil,
        });
        await delegations.record(emissaryDid, credentialDid);
        server.emit('delegation-issued', { subjectDid: emissaryDid, credentialDid });
        return { subjectDid: emissaryDid, credentialDid };
      },
      'POST /api/classify': async ({ body }) => {
        const { kind, text } = (body ?? {}) as ClassifyRequest;
        if (!kind || !text) throw new Error('kind and text are required');
        const r = await createClassifier(config).classify({ kind, text });
        return {
          sensitivity: r.sensitivity,
          sensitivityName: sensitivityName(r.sensitivity),
          tags: (r.metadata.tags as string[] | undefined) ?? [],
          reason: (r.metadata.reason as string | undefined) ?? (r.metadata.error as string) ?? '',
          needsHumanConfirmation: r.needsHumanConfirmation,
        };
      },
      'POST /api/recall': async (ctx) => {
        const { query, k } = (ctx.body ?? {}) as RecallRequest;
        if (!query) throw new Error('query is required');
        // Private RAG over the SESSION member's vault — their own artefacts ∪ shared-to-household, and only
        // the personal vault (kb:null), not the KBs. Query, retrieval, and answer stay on this device.
        const viewer = effectiveViewer(ctx);
        const result = await RecallService.forWarden(handle, config).recall(query, { ...(k ? { k } : {}), kb: null, owner: viewer });
        return { result };
      },
      // Forge (Sevenfold) — mint an Attestation scroll from a divination. Reuses the evidence flow: a
      // MEDIUM+ forge triggers the same out-of-band Signet evidence-approval the DIDComm path uses;
      // LOW/witnessed clears at STANDING with no step-up. The browser holds no key.
      'POST /api/forge': async (ctx) => {
        const { claim, kind, from, to, structured, validForMinutes } = (ctx.body ?? {}) as ProveRequest;
        if (!claim || !kind) throw new Error('claim and kind are required');
        // The forge subject is the SESSION member (Phase 3) — a MEDIUM+ forge then step-ups to THAT
        // member's own Signet (the per-member approver, Phase 2), never config.sovereignDid.
        const subjectDid = effectiveViewer(ctx);
        const at = new Date().toISOString();
        const req: EvidenceRequest = {
          type: 'hearthold/evidence-request',
          version: PROTOCOL_VERSION,
          claim,
          disclosureMode: 'ATTESTATION',
          spec: { kind: kind as never, from, to, structured },
          ...(subjectDid ? { subjectDid } : {}),
          ...(validForMinutes ? { validForMinutes } : {}),
        };
        // Home-plane forge: the member proves from their own vault (delegationValid = true).
        const r = await evidenceService.handle(req, id.did, true);
        const proof: ProofRecord =
          r.status === 'granted'
            ? {
                id: randomUUID(),
                claim,
                kind,
                status: 'granted',
                credentialDid: r.credentialDid,
                structured: r.graph?.structured,
                evidence: r.graph?.evidence,
                approved: r.graph?.approved,
                validUntil: r.graph?.validUntil,
                issued: r.graph?.issued,
                trustClass: r.graph?.trustClass,
                at,
              }
            : { id: randomUUID(), claim, kind, status: 'denied', reason: r.reason, at };
        if (proof.status === 'granted' && proof.credentialDid) {
          forgeLedger.set(proof.credentialDid, proof.validUntil);
          server.emit('scroll-forged', { proof }, { owner: subjectDid });
        }
        return { proof };
      },
      // Present (Sevenfold) — play the scroll; it BURNS. Single-use enforced verifier-side (the holder
      // can't reset it). Home-plane demonstration; cross-party presentation stays Emissary-side.
      'POST /api/present': async ({ body }) => {
        const { credentialDid } = (body ?? {}) as PresentRequest;
        if (!credentialDid) throw new Error('credentialDid is required');
        if (await spentScrolls.isSpent(credentialDid)) {
          return { verified: false, reason: 'single-use scroll already spent (burned)' };
        }
        const validUntil = forgeLedger.get(credentialDid);
        if (validUntil && new Date(validUntil).getTime() < Date.now()) {
          return { verified: false, reason: 'scroll expired' };
        }
        await spentScrolls.markSpent(credentialDid);
        server.emit('scroll-burned', { credentialDid });
        return { verified: true };
      },

      // Card-face hydration for the Sevenfold Table — crosses decideRelease; a refusal is `granted:false`
      // (obsidian), not an error. The face is unsealed transiently and never cached (G2). Phase 3 fix: the
      // face is computed for the SESSION member (cross-member cards never render) and the tier is
      // server-determined — a MEDIUM+ face requires a REAL step-up to that member's own Signet, never a
      // client-claimed `tier`.
      'POST /api/card/face': async (ctx) => {
        const { artefactId } = (ctx.body ?? {}) as CardFaceRequest;
        if (!artefactId) throw new Error('artefactId is required');
        const viewer = effectiveViewer(ctx);
        const stepUp = makeDidcommActionApprover(transport, config.stepUpTimeoutMs.factor1);
        const achievedTier = async (sensitivity: Sensitivity): Promise<AuthzTier> => {
          if (sensitivity < Sensitivity.MEDIUM) return AuthzTier.STANDING; // authenticated session clears ≤LOW
          if (!viewer) return AuthzTier.STANDING; // no member to step up → MEDIUM+ will refuse
          const ok = await stepUp.requestActionApproval({
            member: viewer,
            action: 'render',
            resource: artefactId,
            summary: `Reveal a ${sensitivityName(sensitivity)} card face`,
          });
          return ok ? AuthzTier.CHALLENGE : AuthzTier.STANDING; // insufficient → the ladder refuses
        };
        const card = await hydrateCardFace(handle, { artefactId, visible: (a) => visibleTo(a, viewer), achievedTier });
        return { card };
      },

      // Triage — the born-obsidian confirmation queue, scoped to the session member's own quarantine.
      'GET /api/triage': async (ctx) => {
        const viewer = effectiveViewer(ctx);
        return { queue: await triageQueue(handle, (a) => visibleTo(a, viewer)) };
      },
      'POST /api/triage/confirm': async (ctx) => {
        const { artefactId, sensitivity } = (ctx.body ?? {}) as TriageConfirmRequest;
        if (!artefactId || sensitivity === undefined) throw new Error('artefactId and sensitivity are required');
        // A member confirms only their OWN quarantine — refuse a cross-member confirm.
        const target = await store.get(artefactId);
        if (!target || !visibleTo(target, effectiveViewer(ctx))) throw new Error('not available');
        const item = await confirmTriage(handle, { artefactId, sensitivity: sensitivity as Sensitivity });
        server.emit('triage-confirmed', { item }, { owner: effectiveViewer(ctx) });
        return { item };
      },

      // SevenfoldMark — explicit claim; the Warden re-counts and issues (axes-free).
      'POST /api/marks/claimable': async ({ body }) => {
        const { candidates } = (body ?? {}) as { candidates?: MarkCandidate[] };
        return { marks: await claimableMarks(handle, candidates ?? []) };
      },
      'POST /api/marks/claim': async (ctx) => {
        const { candidate } = (ctx.body ?? {}) as MarkClaimRequest;
        // The Mark is issued to the SESSION member (Phase 3) — never a client-asserted subject. This
        // subsumes the old `subjectDid ?? config.sovereignDid` default.
        const subjectDid = effectiveViewer(ctx);
        if (!candidate) throw new Error('candidate is required');
        if (!subjectDid) throw new Error('no session and no Sovereign configured on this Warden');
        const result = await claimMark(handle, { candidate, subjectDid });
        if (result.issued) server.emit('mark-issued', { result }, { owner: subjectDid });
        return { result };
      },

      // ── Knowledge Base membership + assurance policy (many KBs per Warden) ──
      // NB: KB access is granted to the *member* DID (the one that signs in), never to the relaying
      // Mage/Emissary — the Warden authorizes the member, the Mage only carries.
      'GET /api/kb': async () => ({ kbs: await kbList() }),
      'POST /api/kb/grant': async ({ body }) => {
        const { kbId, did, scope } = (body ?? {}) as KbGrantRequest;
        const kb = await kbStore.get(kbId);
        if (!kb) throw new Error(`unknown KB "${kbId}"`);
        if (!did) throw new Error('did is required');
        if (scope === 'read' || scope === 'both') await grantAuthorization(handle, kb.readGroup, did);
        if (scope === 'write' || scope === 'both') await grantAuthorization(handle, kb.writeGroup, did);
        // KB Spaces: granting a member also provisions their private partition (their private DB).
        if (kb.memberPartitions) await provisionMemberPartition(handle, config, kb.kbId, did);
        const kbs = await kbList();
        server.emit('kb-changed', { kbs });
        return { kbs };
      },
      'POST /api/kb/revoke': async ({ body }) => {
        const { kbId, did, scope } = (body ?? {}) as KbGrantRequest;
        const kb = await kbStore.get(kbId);
        if (!kb) throw new Error(`unknown KB "${kbId}"`);
        if (!did) throw new Error('did is required');
        if (scope === 'read' || scope === 'both') await revokeAuthorization(handle, kb.readGroup, did);
        if (scope === 'write' || scope === 'both') await revokeAuthorization(handle, kb.writeGroup, did);
        const kbs = await kbList();
        server.emit('kb-changed', { kbs });
        return { kbs };
      },
      'POST /api/kb/policy': async ({ body }) => {
        const { kbId, action, tier } = (body ?? {}) as KbPolicyRequest;
        const kb = await kbStore.get(kbId);
        if (!kb) throw new Error(`unknown KB "${kbId}"`);
        if ((action !== 'read' && action !== 'write') || (tier !== 'factor1' && tier !== 'factor2')) {
          throw new Error('action must be read|write and tier factor1|factor2');
        }
        // Governance: a governed KB routes the signature to the Sovereign's Signet; else the Warden
        // self-signs. The transport is already live in this daemon.
        const signer = kb.governorDid ? makeDidcommRulesetSigner(transport, kb.governorDid) : selfSigner(handle, id.did);
        const policyAsset = await setKbAssurance(handle, config, kb.kbId, kb.policyAsset, action, tier, signer);
        await kbStore.put({ ...kb, policyAsset });
        const kbs = await kbList();
        server.emit('kb-changed', { kbs });
        return { kbs };
      },
    },
    onListening: (p) =>
      process.stdout.write(
        `Warden control on http://127.0.0.1:${p}\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  DIDComm mailbox serving; console API live. (Ctrl-C to stop)\n`,
      ),
  });

  // Serve a provisioned Knowledge Base over DIDComm too (a public Mage relays to this mailbox).
  // The step-up approver reaches the member's Signet directly (out-of-band from the Mage).
  const kbs = await buildKbServices(handle, config, id.did, makeDidcommActionApprover(transport));

  // Wrap the real handler so a stored submission is pushed to connected consoles.
  const inner = makeWardenHandler(service, delegations, evidenceService, kbs, config.sovereignDid);
  const handler: RequestHandler = async (message, fromDid) => {
    const result = await inner(message, fromDid);
    if (
      result &&
      (result as { type?: string }).type === 'hearthold/submission-receipt' &&
      message.type === 'hearthold/witness-submission'
    ) {
      const receipt = result as SubmissionReceipt;
      const sub = message as WitnessSubmission;
      // The stored artefact carries the attributed owner/scope — scope the event so only that member's
      // console sees their own `submission-stored` (activity metadata is a disclosure, Fable amendment 3).
      const stored = await store.get(receipt.artefactId);
      const item: VaultItem = {
        id: receipt.artefactId,
        kind: sub.kind,
        sensitivity: receipt.assignedSensitivity,
        sensitivityName: sensitivityName(receipt.assignedSensitivity),
        observedAt: sub.observedAt,
        ...(stored?.scope ? { scope: stored.scope } : {}),
      };
      server.emit('submission-stored', { item, from: fromDid }, { owner: stored?.owner ?? config.sovereignDid, scope: stored?.scope });
    }
    return result;
  };

  const stop = await transport.serve(handler);
  const shutdown = (): void => {
    stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
