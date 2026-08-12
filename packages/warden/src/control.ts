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
  ensureAuthorizationSchema,
  issueDelegation,
  reloadWallet,
  DidCommTransport,
  IDENTITY_NAME,
  startControlServer,
  UnauthorizedError,
  grantAuthorization,
  revokeAuthorization,
  selfSigner,
  AuthzTier,
  requiredTier,
  clearanceCeiling,
  Sensitivity,
  FileSpentTxnStore,
  PROTOCOL_VERSION,
  rulesetId,
  deliverCredential,
  DmzSession,
  verifyForeignCredential,
  buildIssuedLeaf,
  sealForWarden,
  unsealAsWarden,
  GroupTrustRegistry,
  type HearthholdConfig,
  type KeymasterHandle,
  type RequestHandler,
  type ResolvedCredential,
  type IssuedLeaf,
  type CredentialDeliveryMessage,
  type CredentialDeliveryAckMessage,
  type SubmissionReceipt,
  type WitnessSubmission,
  type WitnessKind,
  type Ruleset,
  type SignedRuleset,
  type FlowEvent,
  type FlowEventMessage,
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
  type CardPassRequest,
  type CardReceivedEvent,
  type CardAuthenticity,
  type CardAcceptRequest,
  type CardAcceptResponse,
  type CardAcceptedEvent,
  type CardDeclineRequest,
  type CardDeclinedEvent,
  type TriageConfirmRequest,
  type MarkCandidate,
  type MarkClaimRequest,
  type KbView,
  type KbGrantRequest,
  type KbPolicyRequest,
} from '@hearthold/control-types';

import { createClassifier } from './classifier.js';
import { createVisionCaptioner } from './vision.js';
import { WardenService } from './service.js';
import { VaultStore, type Artefact } from './store.js';
import { DelegationStore } from './delegations.js';
import { EvidenceService, makeDidcommDischargeRequester } from './evidence.js';
import { ChallengeStore } from './challenge-store.js';
import { OllamaEmbedder, RecallService } from './recall.js';
import { makeDidcommActionApprover, makeDidcommRulesetSigner, makeDidcommMemberAcker } from './kb.js';
import { routeCoSign } from './escalate.js';
import { hydrateCardFace } from './face.js';
import { triageQueue, confirmTriage } from './triage.js';
import { InboundCardStore, type StoredInboundCard } from './inbound-card-store.js';
import { SpendReceiptStore } from './spend-receipt-store.js';
import { AutofileStore } from './autofile-store.js';
import { promoteVerifiedCard } from './credential-vault.js';
import { claimableMarks, claimMark } from './marks.js';
import { buildKbServices, KbConfigStore, setKbAssurance, readKbAssurance, provisionMemberPartition } from './kb-config.js';
import { makeWardenHandler } from './handler.js';
import { ControlSessionStore } from './control-session.js';
import { SessionKeyStore } from './session-keys.js';
import { unlockSessionPartitions, type RewrapChannel } from './rewrap.js';
import { HouseholdConfigStore } from './household-config.js';
import { admitMember, removeMember, shareToHousehold } from './household.js';
import { GuardianshipStore, GuardianReceiptStore, activeGuardianships, guardianRead } from './guardianship.js';

/**
 * Surface an agent→agent card move on the family watch (the Sovereign's Invocation Dashboard A2A flow).
 * ENVELOPE-ONLY by construction — who→whom, kind, outcome; NEVER the content (the disclosure went to the
 * audience, not the governor). Fire-and-forget + best-effort: a watch that's down never blocks the pass.
 * Mirrors the Emissary's `reportFlow`; the watcher's ingest overrides `from` with the authcrypt sender.
 */
async function reportCardFlow(handle: KeymasterHandle, watchDid: string, flow: Omit<FlowEvent, 'ts'>): Promise<void> {
  const msg: FlowEventMessage = { type: 'hearthold/flow-event', version: PROTOCOL_VERSION, flow: { ...flow, ts: new Date().toISOString() } };
  await handle.keymaster.sendDidComm({ type: msg.type, thid: randomUUID(), body: msg }, watchDid, { name: IDENTITY_NAME.warden });
}

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
  passphrase: string,
): Promise<void> {
  const id = await ensureIdentity(handle, config);
  // The DMZ factory: an ephemeral, PEERLESS gatekeeper a cross-node card is verified inside (never our own
  // gatekeeper — B6). Undefined when no DMZ is configured (HEARTHOLD_DMZ_URL unset) → cross-node cards stay
  // verified:false (fail closed). `assumePeerless` is the explicit escape hatch for a stand-in target.
  const openDmz: (() => Promise<DmzSession>) | undefined = config.dmzNodeUrl
    ? (): Promise<DmzSession> =>
        DmzSession.open({
          dmzNodeUrl: config.dmzNodeUrl!,
          role: 'warden',
          config,
          passphrase,
          ...(config.dmzApiKey ? { apiKey: config.dmzApiKey } : {}),
          ...(config.dmzAssumePeerless ? { assumePeerless: true } : {}),
        })
    : undefined;
  const store = new VaultStore(handle.dataFolder);
  const delegations = new DelegationStore(handle);
  const kbStore = new KbConfigStore(handle.dataFolder);
  const householdStore = new HouseholdConfigStore(handle.dataFolder);
  // Guardianship (Phase 5): one governor↔member Ruleset chain per edge + inward access receipts.
  const guardianships = new GuardianshipStore(handle.dataFolder);
  const guardianReceipts = new GuardianReceiptStore(handle.dataFolder);
  // Control-plane sessions: a member proves DID control at login; the Table rides an opaque bearer token.
  const sessions = new ControlSessionStore(config.sessionTtlMs);
  // The read-guest keys: transient partition keys held only for the session (in memory; zeroized at its end).
  const sessionKeys = new SessionKeyStore();
  // Pending inbound cards passed from other nodes: verified but not yet accepted into the vault.
  const inboundCards = new InboundCardStore(handle.dataFolder);
  // Agent-family spend observation feed: the parent's passive log of agent spends (docs/agent-family.md).
  const spendReceipts = new SpendReceiptStore(handle.dataFolder);
  // ── Reload-before-write guard (L1-2). This daemon caches the Warden wallet in memory for its lifetime,
  // so a wallet MUTATION (issuing a delegation/mark/evidence VC, a KB grant/revoke) would write a stale
  // cache back over a concurrent `warden` CLI write via Keymaster's non-atomic saveWallet → clobber. Route
  // every wallet mutation through `withWalletWrite`: it (1) SERIALIZES mutations so two requests can't race
  // each other, and (2) reloads the wallet from disk (torn-read retry, fail-closed) immediately before the
  // write so an external change is never overwritten. Reads (recall/snapshot/status) don't need it. This is
  // the Warden's analogue of the Sovereign's per-request `openKeymasterFresh`, adapted to the shared handle.
  let walletWrites: Promise<unknown> = Promise.resolve();
  const withWalletWrite = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = walletWrites.then(async () => {
      await reloadWallet(handle);
      return fn();
    });
    walletWrites = run.then(() => undefined, () => undefined); // keep the chain alive across a failed write
    return run;
  };
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
  // server-side, never from anything the client sends. The viewer is the authenticated session member; when
  // unauthenticated it falls back to the configured Sovereign (single-Sovereign back-compat) UNLESS
  // require-session is on, in which case there is NO anonymous fallback — the scoped route throws 401 and
  // the caller must log in. Set below, before serving (derived from multi-membership when the env is unset).
  // Pre-family artefacts (no owner) belong to the Sovereign; an artefact is visible iff the viewer owns it
  // or it is shared.
  let requireSession = false;
  const effectiveViewer = (ctx: { req: { headers: Record<string, string | string[] | undefined> } }): string | undefined => {
    const sessionDid = sessions.resolve(sessionToken(ctx));
    if (sessionDid) return sessionDid;
    if (requireSession) throw new UnauthorizedError(); // identity proven, never asserted-by-absence
    return config.sovereignDid; // single-Sovereign back-compat (no members admitted)
  };
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
  const service = new WardenService(handle, createClassifier(config), embedder, createVisionCaptioner(config));

  const transport = new DidCommTransport(handle, IDENTITY_NAME.warden, config.nodeUrl);
  await transport.ready();

  // Wire the consent channel (audit-3 §3) — a sensitive disclosure routes to the owner's Signet over DIDComm;
  // without it, MEDIUM+ fails closed. And the Warden-minted challenge store (§1) for invocation + delegation.
  const evidenceService = new EvidenceService(handle, config, makeDidcommDischargeRequester(transport));
  const challenges = new ChallengeStore(handle, config.registry, config.sovereignDid, config.authorizationSchemaDid);

  // The canonical schema DIDs this Warden challenges against, computed once (idempotent registration). Surfaced
  // in /api/status so an operator can wire the authorization one into the Sovereign's
  // HEARTHOLD_AUTHORIZATION_SCHEMA_DID — schema DIDs are not content-addressed across wallets, so the issuer
  // must reference the Warden's canonical schema rather than register its own.
  const authorizationSchemaDid = config.authorizationSchemaDid ?? (await ensureAuthorizationSchema(handle));
  const delegationSchemaDid = await ensureDelegationSchema(handle);

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
    authorizationSchemaDid,
    delegationSchemaDid,
  });

  // A delegation belongs to the member it serves (`memberDid`), defaulting to the configured Sovereign for
  // legacy single-Sovereign delegations — same ownership rule as `ownerOf` for artefacts. Owner-scope it so
  // one member never sees another's Emissary relationships, then strip `memberDid` (not part of the wire view).
  const delegationsFor = async (viewer: string | undefined): Promise<{ subjectDid: string; credentialDid: string }[]> =>
    (await delegations.list())
      .filter((d) => (d.memberDid ?? config.sovereignDid) === viewer)
      .map(({ subjectDid, credentialDid }) => ({ subjectDid, credentialDid }));

  const snapshot = async (viewer: string | undefined): Promise<WardenSnapshot> => ({
    status: await status(),
    vault: (await store.list()).filter((a) => visibleTo(a, viewer)).map(toVaultItem),
    delegations: await delegationsFor(viewer),
  });

  // The sensitivity ceiling a recall/RAG answer may draw on: a bare session clears only ≤LOW; requesting
  // MEDIUM+ runs a real step-up to the member's OWN Signet (the same out-of-band approver a MEDIUM+ card-face
  // uses), and the ceiling granted is exactly what the achieved tier clears. No member / no approval → ≤LOW.
  const recallCeiling = async (requested: Sensitivity, member: string | undefined): Promise<Sensitivity> => {
    if (requested <= Sensitivity.LOW || !member) return clearanceCeiling(AuthzTier.STANDING);
    const need = requiredTier(requested);
    const stepUp = makeDidcommActionApprover(transport, need >= AuthzTier.HUMAN ? config.stepUpTimeoutMs.factor2 : config.stepUpTimeoutMs.factor1);
    const ok = await stepUp.requestActionApproval({
      member,
      action: 'recall',
      resource: `<=${sensitivityName(requested)}`,
      summary: `Recall over your ${sensitivityName(requested)} vault`,
    });
    return clearanceCeiling(ok ? need : AuthzTier.STANDING);
  };

  // Governance co-sign: an authority-granting or membership-changing action requires a real Signet approval
  // from the relevant principal — the KB/household governor, or the acting member for a self-governed
  // resource. Fail closed (a declined / unreachable Signet blocks the action). Same approver the card-pass +
  // household routes use.
  const coSign = async (member: string, action: string, resource: string, summary: string): Promise<void> => {
    const ok = await makeDidcommActionApprover(transport, config.stepUpTimeoutMs.factor2).requestActionApproval({
      member,
      action,
      resource,
      summary,
    });
    if (!ok) throw new Error(`${action} declined — a Signet co-sign is required (${summary})`);
  };

  // Retire the anonymous Sovereign fallback once the node is multi-member. Explicit env wins; otherwise
  // DERIVE the safe posture — on if a household exists or any KB space has a member other than the
  // Sovereign, off for a bare single-Sovereign node. Safe-by-construction: it turns on exactly when a
  // second principal can reach the daemon, not when a human remembers a flag.
  const isMultiMember = async (): Promise<boolean> => {
    if (await householdStore.get().catch(() => null)) return true;
    const kbs = await kbList().catch(() => [] as KbView[]);
    return kbs.some((kb) => [...kb.readers, ...kb.writers].some((d) => d && d !== config.sovereignDid));
  };
  requireSession = config.requireSession ?? (await isMultiMember());

  // Lockout guard: warn loudly when require-session is on so an operator can't be silently 401'd out of
  // their own daemon — especially when it turned on by DERIVATION (multi-membership), which is automatic.
  if (requireSession) {
    const how = config.requireSession === true ? 'HEARTHOLD_REQUIRE_SESSION=true' : 'derived — this node is multi-member';
    process.stderr.write(
      `\n⚠️  require-session is ON (${how}).\n` +
        `   Every scoped control read needs a proven session (${'X-Hearthold-Session'} header); an unauthenticated caller gets 401.\n` +
        `   To get in you MUST be able to log in: the Signet daemon (POST /api/login/sign, :4311) reachable and your member wallet present.\n` +
        `   No login path = locked out. Restore the single-Sovereign fallback with HEARTHOLD_REQUIRE_SESSION=false.\n\n`,
    );
  }

  const server = startControlServer({
    port,
    host: config.controlHost,
    allowOrigins: config.controlAllowOrigins,
    // SSE audience filtering (Phase 3): resolve each console's viewer DID so a member's events don't reach
    // another member's stream. Falls back to undefined (broadcast-eligible) when unauthenticated.
    resolveSession: (token) => sessions.resolve(token ?? null) ?? undefined,
    routes: {
      // Stays reachable unauthenticated (a login screen needs liveness + identity). On a require-session
      // node, a pre-login caller gets NO vault metadata — `artefactCount`/`delegationCount` are omitted.
      'GET /api/status': async (ctx) => {
        const sessionDid = sessions.resolve(sessionToken(ctx));
        const full = await status();
        if (requireSession && !sessionDid) {
          const { artefactCount: _a, delegationCount: _d, ...liveness } = full;
          return { status: { ...liveness, sessionDid: undefined } };
        }
        return { status: { ...full, sessionDid: sessionDid ?? undefined } };
      },
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
      'POST /api/delegate': async (ctx) => {
        const { emissaryDid, kinds } = (ctx.body ?? {}) as DelegateRequest;
        if (!emissaryDid) throw new Error('emissaryDid is required');
        // Session-gated (was reachable UNAUTHENTICATED — it bypassed require-session by never calling
        // effectiveViewer, and minted a delegation for any body-supplied DID). Delegating submission
        // authority to an Emissary is a (c) delegates-authority act → the delegator's own Signet co-signs.
        const actor = effectiveViewer(ctx);
        if (!actor) throw new Error('no session — log in');
        await coSign(actor, 'delegate', emissaryDid, `Delegate submission authority to ${emissaryDid}`);
        const schemaDid = await ensureDelegationSchema(handle);
        const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
        // Scope the delegation to the requested kinds (a per-path Emissary, e.g. ['image']), else the default
        // TEXT set — `image` is never granted by default; a dedicated image Emissary must ask for it.
        const grantKinds: WitnessKind[] = kinds && kinds.length > 0 ? (kinds as WitnessKind[]) : ['event', 'location', 'activity', 'browsing', 'document', 'book', 'link'];
        const credentialDid = await withWalletWrite(() =>
          issueDelegation(handle, emissaryDid, schemaDid, { kinds: grantKinds, validUntil }),
        );
        await delegations.record(emissaryDid, credentialDid, actor, grantKinds);
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
        const { query, k, maxSensitivity } = (ctx.body ?? {}) as RecallRequest;
        if (!query) throw new Error('query is required');
        // Private RAG over the SESSION member's vault — their own artefacts ∪ shared-to-household, and only
        // the personal vault (kb:null), not the KBs. Query, retrieval, and answer stay on this device.
        // Sensitivity CEILING: recall is a LOCAL_RENDER disclosure like a card face, so it crosses the same
        // ladder. A bare session draws on ≤LOW only; MEDIUM+ (incl. SEALED) requires a real step-up to the
        // member's own Signet — never summarize sealed content for a caller who hasn't cleared it.
        const viewer = effectiveViewer(ctx);
        const requested = typeof maxSensitivity === 'number' ? (maxSensitivity as Sensitivity) : Sensitivity.LOW;
        const ceiling = await recallCeiling(requested, viewer);
        const result = await RecallService.forWarden(handle, config).recall(query, {
          ...(k ? { k } : {}),
          kb: null,
          owner: viewer,
          maxSensitivity: ceiling,
        });
        return { result };
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
        const achievedTier = async (sensitivity: Sensitivity): Promise<AuthzTier> => {
          if (sensitivity < Sensitivity.MEDIUM) return AuthzTier.STANDING; // authenticated session clears ≤LOW
          if (!viewer) return AuthzTier.STANDING; // no member to step up → MEDIUM+ will refuse
          // Escalate the step-up to the tier the card actually needs (was capped at CHALLENGE, so HIGH/SEALED
          // refused even after a successful approval). A session-authenticated member who performs a Signet
          // approval has genuinely cleared up to MULTIFACTOR: the session is factor-1, and the Signet adds
          // device-possession + a PIN (proof-of-human) as factor-2 — so a successful approval satisfies the
          // required tier, it does not over-grant. HIGH/SEALED get the longer factor-2 window; the summary
          // names the sensitivity so the human's consent is informed.
          const need = requiredTier(sensitivity); // CHALLENGE (MEDIUM) | HUMAN (HIGH) | MULTIFACTOR (SEALED)
          const timeout = need >= AuthzTier.HUMAN ? config.stepUpTimeoutMs.factor2 : config.stepUpTimeoutMs.factor1;
          const stepUp = makeDidcommActionApprover(transport, timeout);
          const ok = await stepUp.requestActionApproval({
            member: viewer,
            action: 'render',
            resource: artefactId,
            summary: `Reveal a ${sensitivityName(sensitivity)} card face`,
          });
          return ok ? need : AuthzTier.STANDING; // grant exactly the tier the assurance satisfied; else the ladder refuses
        };
        const card = await hydrateCardFace(handle, { artefactId, visible: (a) => visibleTo(a, viewer), achievedTier });
        return { card };
      },

      // Pass a card to another node — wraps core `deliverCredential`. Session-scoped: the deliverer is the
      // authenticated session member (never a client-asserted issuer). Passing a card crosses a PUBLICATION
      // boundary (it discloses a credential to another party), so it requires the member's Signet co-sign
      // (docs/CO-SIGN-POLICY.md) — the same out-of-band approver a MEDIUM+ card-face uses. The Warden
      // delivers as custodian on the member's behalf (the control transport authcrypts as the Warden); the
      // credential keeps its original issuer signature (deliverCredential packages + ships, never re-signs).
      'POST /api/card/pass': async (ctx) => {
        const { toDid, credentialDid, schemaDid, readable } = (ctx.body ?? {}) as CardPassRequest;
        if (!toDid || !credentialDid) throw new Error('toDid and credentialDid are required');
        const member = effectiveViewer(ctx);
        if (!member) throw new Error('no session — log in');
        // A READABLE pass discloses the claims (crosses decideRelease), not just provenance — name it so the
        // co-signer's consent is informed that content is being handed over, not merely proof.
        const summary = readable ? `Pass a READABLE card (claims disclosed) to ${toDid}` : `Pass a card to ${toDid}`;
        let approved: boolean;
        if (config.parentDid) {
          // AGENT plane: route the co-sign through the escalation ladder (docs/agent-family.md). A readable
          // disclosure is above the agent's standing authority → the PARENT's Signet co-signs; a provenance-only
          // pass is within scope → the AGENT's own Signet self-approves (its AgentGate). Same ladder as spend.
          const tier = readable ? AuthzTier.HUMAN : AuthzTier.CHALLENGE;
          const outcome = await routeCoSign(
            transport,
            { agentDid: member, parentDid: config.parentDid },
            tier,
            { action: 'pass', resource: credentialDid, summary },
            config.stepUpTimeoutMs,
          );
          approved = outcome.approved;
        } else {
          // Classic single-Sovereign plane: the acting member co-signs directly (back-compat).
          approved = await makeDidcommActionApprover(transport, config.stepUpTimeoutMs.factor2).requestActionApproval({
            member,
            action: 'pass',
            resource: credentialDid,
            summary,
          });
        }
        if (!approved) throw new Error('pass declined — a co-sign is required to disclose a credential to another party (readable → the parent, provenance → the agent)');
        // Readable handover (opt-in): the sender (who CAN read the VC) seals a rendering of the claims to
        // toDid so the recipient can decrypt it, shipped beside the immutable ops. Best-effort — if we can't
        // read the VC, the pass still delivers as provenance-only. Only the sender can supply readable content.
        let recipientSealed: string | undefined;
        if (readable) {
          const vc = await handle.keymaster.getCredential(credentialDid).catch(() => null);
          if (vc) {
            const leaf = buildIssuedLeaf(credentialDid, vc as ResolvedCredential);
            recipientSealed = await sealForWarden(handle, toDid, JSON.stringify({ claims: leaf.claims, credentialType: leaf.credentialType, subject: leaf.subject }));
          }
        }
        // Ship the issuer ops (the refreshable throwaway): a cross-node recipient verifies this card inside a
        // PEERLESS DMZ, which cannot resolve the issuer fresh over a peer — so without them `verifyChain`
        // fails "issuer unresolvable". This makes the recipient's `verified:true` mean "chain-consistent"; the
        // recipient upgrades to "issuer-authentic" only by cross-checking the issuer against its OWN federated
        // resolution (see the receipt handler's authenticity check). On a shared-registry recipient the extra
        // ops are a harmless no-op (the VC is already resolvable there).
        const ack = await deliverCredential(handle, IDENTITY_NAME.warden, transport, toDid, credentialDid, {
          ...(schemaDid ? { schemaDid } : {}),
          includeIssuerOps: true,
          // The pass blocks on the recipient's cross-node ack; over a Tor substrate a slow-but-successful
          // ack can exceed the 60s transport default and be wrongly abandoned. Operator-tunable via env.
          timeoutMs: config.cardPassTimeoutMs,
          ...(recipientSealed ? { recipientSealed } : {}),
        });
        // Surface this pass on the family watch (the Invocation Dashboard's live A2A flow) — envelope-only,
        // best-effort. Report to the governing/parent Sovereign (the family's human watch point); on a lone
        // agent, fall back to its own Sovereign. Never blocks or fails the pass.
        const watchDid = config.parentDid ?? config.sovereignDid;
        if (watchDid) void reportCardFlow(handle, watchDid, { from: member, to: toDid, kind: readable ? 'readable-card' : 'card-pass', decision: 'granted' }).catch(() => undefined);
        return {
          ack: {
            credentialDid: ack.credentialDid,
            accepted: ack.accepted,
            ...(ack.reason ? { reason: ack.reason } : {}),
            ...(ack.ingestedArtefactId ? { ingestedArtefactId: ack.ingestedArtefactId } : {}),
          },
        };
      },

      // The pending-inbound queue — cards passed from other nodes, verified but not yet accepted into the
      // vault (born obsidian; import happens on the member's explicit accept). Scoped to the session member.
      'GET /api/card/inbound': async (ctx) => ({ inbound: inboundCards.list(effectiveViewer(ctx)) }),

      // Agent-family SPEND observation feed — the parent's passive log of agent spends (autonomous
      // notify-mode settlements + the outcomes of gated ones). Written by the process that runs
      // authorizeSpend + settlement; served here from the same data root. See docs/agent-family.md.
      'GET /api/spend/receipts': async () => ({ receipts: await spendReceipts.list() }),

      // Promote a pending inbound card into the vault. The verification already happened AT RECEIPT (natively
      // or in the DMZ); accept is a cheap promotion of the already-verified closure. Session-gated +
      // owner-scoped + verification-gated. NOT co-signed: an inward accept grants nothing over anyone else —
      // it imports the closure the Warden already vetted into the member's own peerless vault (Warden custody,
      // no foreign gatekeeper ops). The Signet is reserved for outward/binding acts, not this.
      'POST /api/card/accept': async (ctx) => {
        const { credentialDid } = (ctx.body ?? {}) as CardAcceptRequest;
        if (!credentialDid) throw new Error('credentialDid is required');
        const viewer = effectiveViewer(ctx);
        if (!viewer) throw new Error('no session — log in');
        const card = inboundCards.getStored(credentialDid);
        // Owner-scoped: only the card's own recipient may accept — a cross-member accept is a uniform refusal
        // (indistinguishable from a non-existent card).
        if (!card || card.owner !== viewer) throw new Error('not available');
        // Fail-closed: an unverified card (cross-node that never passed the DMZ, or a native unreadable one)
        // has no closure and can NEVER be imported. There is no code path that imports from raw ops.
        if (!card.verified || !card.closure) {
          throw new Error('card is not verified — refusing to import (a cross-node card must pass the DMZ first)');
        }
        const artefactId = await promoteVerifiedCard(handle, {
          wardenDid: id.did,
          ownerDid: viewer,
          leaf: card.closure,
          ...(card.authenticity ? { authenticity: card.authenticity } : {}),
          ...(card.contentReadable !== undefined ? { contentReadable: card.contentReadable } : {}),
        });
        inboundCards.remove(credentialDid);
        const event: CardAcceptedEvent = { credentialDid, artefactId, owner: viewer, acceptedAt: new Date().toISOString() };
        server.emit('card-accepted', event, { owner: viewer });
        return { artefactId } satisfies CardAcceptResponse;
      },

      // Decline a pending inbound card — drop it from the queue WITHOUT importing (completes the triage
      // surface). Session-gated + owner-scoped (uniform refusal). Nothing is verified or promoted; it just
      // removes the pending entry, so the member can dismiss a card they don't want.
      'POST /api/card/decline': async (ctx) => {
        const { credentialDid } = (ctx.body ?? {}) as CardDeclineRequest;
        if (!credentialDid) throw new Error('credentialDid is required');
        const viewer = effectiveViewer(ctx);
        if (!viewer) throw new Error('no session — log in');
        const card = inboundCards.getStored(credentialDid);
        if (!card || card.owner !== viewer) throw new Error('not available');
        inboundCards.remove(credentialDid);
        const event: CardDeclinedEvent = { credentialDid, owner: viewer, declinedAt: new Date().toISOString() };
        server.emit('card-declined', event, { owner: viewer });
        return { ok: true };
      },

      // Triage — the born-obsidian confirmation queue, scoped to the session member's own quarantine.
      'GET /api/triage': async (ctx) => {
        const viewer = effectiveViewer(ctx);
        return { queue: await triageQueue(handle, (a) => visibleTo(a, viewer)) };
      },
      'POST /api/triage/confirm': async (ctx) => {
        const { artefactId, sensitivity } = (ctx.body ?? {}) as TriageConfirmRequest;
        if (!artefactId || sensitivity === undefined) throw new Error('artefactId and sensitivity are required');
        const viewer = effectiveViewer(ctx);
        // A member confirms only their OWN quarantine — refuse a cross-member confirm.
        const target = await store.get(artefactId);
        if (!target || !visibleTo(target, viewer)) throw new Error('not available');
        const requested = sensitivity as Sensitivity;
        // Lowering an artefact's classification is a declassification — a disclosure-authorizing act, like
        // every comparable write. Require the owner's Signet co-sign (this is what makes `confirmedBySovereign`
        // a real proof-of-human, not just a control-plane call); relaxing SEALED costs what SEALED costs.
        // Raising or keeping sensitivity is fail-safe → no step-up.
        if (viewer && requested < target.sensitivity) {
          await coSign(viewer, 'triage-relax', artefactId, `Reclassify ${sensitivityName(target.sensitivity)} → ${sensitivityName(requested)}`);
        }
        const item = await confirmTriage(handle, { artefactId, sensitivity: requested });
        // ADMISSION: the Sovereign's confirm is what lets the item enter the recall corpus. Index it now
        // (it was withheld at submit as born-obsidian) — this is the point an Emissary's proposal becomes
        // searchable content, and only the Sovereign performs it.
        const confirmed = await store.get(artefactId);
        if (confirmed) await service.indexArtefact(confirmed);
        server.emit('triage-confirmed', { item }, { owner: viewer });
        return { item };
      },

      // SevenfoldMark — explicit claim; the Warden re-counts and issues (axes-free).
      'POST /api/marks/claimable': async (ctx) => {
        const { candidates } = (ctx.body ?? {}) as { candidates?: MarkCandidate[] };
        // Session-gated + owner-scoped: the count is over the member's OWN visible set, never the whole
        // household (a household-wide count-by-kind is a cross-member metadata leak).
        const viewer = effectiveViewer(ctx);
        if (!viewer) throw new Error('no session — log in');
        return { marks: await claimableMarks(handle, candidates ?? [], viewer, config.sovereignDid) };
      },
      'POST /api/marks/claim': async (ctx) => {
        const { candidate } = (ctx.body ?? {}) as MarkClaimRequest;
        // The Mark is issued to the SESSION member (Phase 3) — never a client-asserted subject. This
        // subsumes the old `subjectDid ?? config.sovereignDid` default.
        const subjectDid = effectiveViewer(ctx);
        if (!candidate) throw new Error('candidate is required');
        if (!subjectDid) throw new Error('no session and no Sovereign configured on this Warden');
        const result = await withWalletWrite(() => claimMark(handle, { candidate, subjectDid }, config.sovereignDid));
        if (result.issued) server.emit('mark-issued', { result }, { owner: subjectDid });
        return { result };
      },

      // ── Household governance (Phase 4) — the Warden EXECUTES; the Master-Sovereign AUTHORIZES at their
      // Signet (PVM separation). Admit/remove are governor-authorized; share is owner-driven under a tier.
      'POST /api/household/admit': async (ctx) => {
        const { memberDid } = (ctx.body ?? {}) as { memberDid?: string };
        if (!memberDid) throw new Error('memberDid is required');
        const hh = await householdStore.get();
        if (!hh) throw new Error('no household provisioned (run `warden household-init`)');
        const gov = makeDidcommActionApprover(transport, config.stepUpTimeoutMs.factor2);
        const ok = await gov.requestActionApproval({ member: hh.governorDid, action: 'admit-member', resource: hh.householdId, summary: `Admit ${memberDid.slice(0, 20)}… to the household` });
        if (!ok) throw new Error('admission declined by the Master-Sovereign');
        const partition = await admitMember(handle, config, hh, memberDid);
        server.emit('household-changed', { admitted: memberDid });
        return { admitted: memberDid, partition: partition.id };
      },
      'POST /api/household/remove': async (ctx) => {
        const { memberDid } = (ctx.body ?? {}) as { memberDid?: string };
        if (!memberDid) throw new Error('memberDid is required');
        const hh = await householdStore.get();
        if (!hh) throw new Error('no household provisioned');
        const gov = makeDidcommActionApprover(transport, config.stepUpTimeoutMs.factor2);
        const ok = await gov.requestActionApproval({ member: hh.governorDid, action: 'remove-member', resource: hh.householdId, summary: `Remove ${memberDid.slice(0, 20)}… from the household` });
        if (!ok) throw new Error('removal declined by the Master-Sovereign');
        // removeMember zeroizes the removed member's live read-guest keys immediately (§4.3, watch-item #1).
        const result = await removeMember(handle, config, hh, memberDid, sessions, sessionKeys);
        server.emit('household-changed', { removed: memberDid });
        return { removed: memberDid, ...result };
      },
      // Share a member's OWN item to the household — owner-only, contributor-tier, sensitivity-scaled step-up.
      'POST /api/vault/share': async (ctx) => {
        const { artefactId } = (ctx.body ?? {}) as { artefactId?: string };
        if (!artefactId) throw new Error('artefactId is required');
        const hh = await householdStore.get();
        if (!hh) throw new Error('no household provisioned');
        const viewer = effectiveViewer(ctx);
        if (!viewer) throw new Error('no session — log in');
        const stepUp = makeDidcommActionApprover(transport, config.stepUpTimeoutMs.factor2);
        const result = await shareToHousehold(handle, config, hh, artefactId, viewer, (sensitivity) =>
          stepUp.requestActionApproval({ member: viewer, action: 'share', resource: artefactId, summary: `Share a ${sensitivityName(sensitivity)} note to the household` }),
        );
        if (result.shared) server.emit('household-changed', { shared: artefactId }, { scope: 'shared' });
        return result;
      },

      // ── Guardianship (Phase 5) — governor access to member DATA, grantable but never seizable. Every
      // edge is a governor↔member Ruleset chain: the governor signs at their Signet, the SUBJECT member
      // acknowledges at THEIRS (the amendment rule), reads are scoped + receipted inward, and the member
      // sees who watches them. A grant with no member ack authorizes nothing.
      //
      // Grant a guardianship edge — the household governor proposes read access over a member. Governor-
      // signed (their own Signet); it is PENDING until the subject acknowledges (POST /api/guardian/ack).
      'POST /api/guardian/grant': async (ctx) => {
        const { subjectDid, kinds, ceiling, validUntil } = (ctx.body ?? {}) as {
          subjectDid?: string; kinds?: string[]; ceiling?: number; validUntil?: string;
        };
        if (!subjectDid) throw new Error('subjectDid is required');
        const viewer = effectiveViewer(ctx);
        const hh = await householdStore.get();
        if (!hh) throw new Error('no household provisioned');
        if (viewer !== hh.governorDid) throw new Error('only the household governor may grant guardianship');
        const chain = await guardianships.chain(viewer, subjectDid);
        const head = chain[chain.length - 1];
        const next: Ruleset = {
          actor: viewer, actorKind: 'guardianship', resource: `guard:${subjectDid}`,
          version: (head?.version ?? 0) + 1, previous: head ? rulesetId(head) : null,
          capabilities: { kinds: kinds ?? [], verbs: ['read'] },
          ceiling: ceiling ?? Sensitivity.LOW, status: 'active', subject: subjectDid,
          ...(validUntil ? { validUntil } : {}),
        };
        const signer = makeDidcommRulesetSigner(transport, viewer, config.stepUpTimeoutMs.factor2);
        const summary = `Watch ${subjectDid.slice(0, 20)}… — ${(kinds ?? []).join(', ') || 'no kinds'} ≤ ${sensitivityName(ceiling ?? Sensitivity.LOW)}${validUntil ? `, until ${validUntil.slice(0, 10)}` : ''}`;
        const signed = await signer.sign(next, summary);
        if (!signed) throw new Error('guardianship grant declined by the governor');
        await guardianships.append(viewer, subjectDid, signed);
        // Conspicuous, always: tell the subject a guardianship was proposed over them.
        server.emit('guardianship-proposed', { governor: viewer, subject: subjectDid }, { owner: subjectDid });
        return { proposed: true, governor: viewer, subject: subjectDid, acknowledged: false };
      },
      // Acknowledge a pending guardianship — the SUBJECT member co-signs at their own Signet, activating it.
      'POST /api/guardian/acknowledge': async (ctx) => {
        const { governorDid } = (ctx.body ?? {}) as { governorDid?: string };
        if (!governorDid) throw new Error('governorDid is required');
        const viewer = effectiveViewer(ctx);
        if (!viewer) throw new Error('no session — log in');
        const chain = await guardianships.chain(governorDid, viewer);
        const head = chain[chain.length - 1];
        if (!head) throw new Error('no guardianship to acknowledge');
        const acker = makeDidcommMemberAcker(transport, viewer, config.stepUpTimeoutMs.factor2);
        const summary = `Acknowledge being watched by ${governorDid.slice(0, 20)}… — ${(head.capabilities?.kinds ?? []).join(', ') || 'no kinds'} ≤ ${sensitivityName(head.ceiling ?? Sensitivity.LOW)}`;
        const memberAck = await acker(head, summary);
        if (!memberAck) throw new Error('acknowledgment declined by the member');
        const acked: SignedRuleset = { ...head, memberAck };
        await guardianships.replaceChain(governorDid, viewer, [...chain.slice(0, -1), acked]);
        return { acknowledged: true, governor: governorDid, subject: viewer };
      },
      // A governor reads a member's artefact under an active, acknowledged, in-scope guardianship. Every
      // ALLOWED read is receipted to the member; a refusal reveals nothing.
      'POST /api/guardian/read': async (ctx) => {
        const { subjectDid, artefactId } = (ctx.body ?? {}) as { subjectDid?: string; artefactId?: string };
        if (!subjectDid || !artefactId) throw new Error('subjectDid and artefactId are required');
        const viewer = effectiveViewer(ctx);
        if (!viewer) throw new Error('no session — log in');
        const chain = await guardianships.chain(viewer, subjectDid);
        const at = new Date().toISOString();
        const result = await guardianRead(handle, config, chain, viewer, subjectDid, artefactId, at);
        // The watched sees the watching, live — an inward disclosure to the subject only.
        if (result.granted) server.emit('guardian-read', { governor: viewer, artefactId, at }, { owner: subjectDid });
        return result;
      },
      // Revoke a guardianship (emancipation / offboarding) — a governor-signed, self-restricting
      // supersession. Self-restricting ⇒ no member ack needed (reduces access; §3).
      'POST /api/guardian/revoke': async (ctx) => {
        const { subjectDid } = (ctx.body ?? {}) as { subjectDid?: string };
        if (!subjectDid) throw new Error('subjectDid is required');
        const viewer = effectiveViewer(ctx);
        const chain = await guardianships.chain(viewer ?? '', subjectDid);
        const head = chain[chain.length - 1];
        if (!head) throw new Error('no guardianship to revoke');
        const next: Ruleset = {
          actor: head.actor, actorKind: head.actorKind, resource: head.resource,
          version: head.version + 1, previous: rulesetId(head),
          capabilities: head.capabilities, ceiling: head.ceiling, status: 'revoked', subject: head.subject,
          ...(head.validUntil ? { validUntil: head.validUntil } : {}),
        };
        const signer = makeDidcommRulesetSigner(transport, viewer!, config.stepUpTimeoutMs.factor2);
        const signed = await signer.sign(next, `End guardianship over ${subjectDid.slice(0, 20)}…`);
        if (!signed) throw new Error('revocation declined by the governor');
        await guardianships.append(viewer!, subjectDid, signed);
        server.emit('guardianship-proposed', { governor: viewer, subject: subjectDid, revoked: true }, { owner: subjectDid });
        return { revoked: true, governor: viewer, subject: subjectDid };
      },
      // The conspicuous surface: who watches ME (active edges over the session member), what I watch (as a
      // governor), and every guardian read performed over me (the inward receipt log).
      'GET /api/guardianships': async (ctx) => {
        const viewer = effectiveViewer(ctx);
        if (!viewer) throw new Error('no session — log in');
        const watchedBy = await activeGuardianships(handle, guardianships, viewer);
        const watching = await guardianships.forGovernor(viewer);
        const receipts = await guardianReceipts.forSubject(viewer);
        return { watchedBy, watching: watching.map((w) => ({ subject: w.subject })), receipts };
      },

      // ── Knowledge Base membership + assurance policy (many KBs per Warden) ──
      // NB: KB access is granted to the *member* DID (the one that signs in), never to the relaying
      // Mage/Emissary — the Warden authorizes the member, the Mage only carries.
      'GET /api/kb': async () => ({ kbs: await kbList() }),
      'POST /api/kb/grant': async (ctx) => {
        const { kbId, did, scope } = (ctx.body ?? {}) as KbGrantRequest;
        const kb = await kbStore.get(kbId);
        if (!kb) throw new Error(`unknown KB "${kbId}"`);
        if (!did) throw new Error('did is required');
        // Session-gated (was unauthenticated). Granting KB access is (c) delegates-authority → the KB's
        // governor (or the owner of a self-governed KB) co-signs at their Signet.
        const actor = effectiveViewer(ctx);
        if (!actor) throw new Error('no session — log in');
        await coSign(kb.governorDid ?? actor, 'kb-grant', `${kbId}/${did}`, `Grant ${scope ?? 'read'} on ${kbId} to ${did}`);
        await withWalletWrite(async () => {
          if (scope === 'read' || scope === 'both') await grantAuthorization(handle, kb.readGroup, did);
          if (scope === 'write' || scope === 'both') await grantAuthorization(handle, kb.writeGroup, did);
          // KB Spaces: granting a member also provisions their private partition (their private DB).
          if (kb.memberPartitions) await provisionMemberPartition(handle, config, kb.kbId, did);
        });
        const kbs = await kbList();
        server.emit('kb-changed', { kbs });
        return { kbs };
      },
      'POST /api/kb/revoke': async (ctx) => {
        const { kbId, did, scope } = (ctx.body ?? {}) as KbGrantRequest;
        const kb = await kbStore.get(kbId);
        if (!kb) throw new Error(`unknown KB "${kbId}"`);
        if (!did) throw new Error('did is required');
        // Session-gated (was unauthenticated). Revoking membership is a governance change → governor co-sign.
        const actor = effectiveViewer(ctx);
        if (!actor) throw new Error('no session — log in');
        await coSign(kb.governorDid ?? actor, 'kb-revoke', `${kbId}/${did}`, `Revoke ${scope ?? 'read'} on ${kbId} from ${did}`);
        await withWalletWrite(async () => {
          if (scope === 'read' || scope === 'both') await revokeAuthorization(handle, kb.readGroup, did);
          if (scope === 'write' || scope === 'both') await revokeAuthorization(handle, kb.writeGroup, did);
        });
        const kbs = await kbList();
        server.emit('kb-changed', { kbs });
        return { kbs };
      },
      'POST /api/kb/policy': async (ctx) => {
        const { kbId, action, tier } = (ctx.body ?? {}) as KbPolicyRequest;
        const kb = await kbStore.get(kbId);
        if (!kb) throw new Error(`unknown KB "${kbId}"`);
        if ((action !== 'read' && action !== 'write') || (tier !== 'factor1' && tier !== 'factor2')) {
          throw new Error('action must be read|write and tier factor1|factor2');
        }
        // Session-gated (was unauthenticated). The policy CHANGE itself is co-signed below by the governor's
        // Signet (a governed KB) — the ruleset signer is the human gate; a self-governed KB self-signs and
        // relies on the session gate (only the Sovereign holds a session).
        const actor = effectiveViewer(ctx);
        if (!actor) throw new Error('no session — log in');
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
        `Warden control on http://${config.controlHost}:${p}\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  DIDComm mailbox serving; console API live. (Ctrl-C to stop)\n`,
      ),
  });

  // Serve a provisioned Knowledge Base over DIDComm too (a public Mage relays to this mailbox).
  // The step-up approver reaches the member's Signet directly (out-of-band from the Mage).
  const kbs = await buildKbServices(handle, config, id.did, makeDidcommActionApprover(transport), transport as unknown as RewrapChannel);

  // Ingestion trust: a submission quarantines born-obsidian at/below `confirmAtOrBelow` (default SEALED =
  // all) UNLESS its Emissary is in the Sovereign-managed autofile group — the SAME TRQP/group-membership
  // model KB read/write uses. No group provisioned ⇒ nobody bypasses (safe default). An Emissary may
  // PROPOSE; only the Sovereign's triage-confirm ADMITS into the recall/KB corpus.
  const autofileStore = new AutofileStore(handle.dataFolder);
  const isAutofileTrusted = async (emissaryDid: string): Promise<boolean> => {
    const group = autofileStore.group();
    if (!group) return false;
    const tr = new GroupTrustRegistry(handle, [{ action: 'autofile', resource: undefined, group }], id.did);
    return (await tr.authorize({ entity_id: emissaryDid, action: 'autofile' })).authorized;
  };

  // A submission is ack'd immediately ("received & queued"); when the background caption/classify/store lands
  // the artefact, THIS fires — push the real, post-classification `submission-stored` to the owning member's
  // console (scoped: activity metadata is a disclosure). Runs off the reply path, so a slow vision model
  // never delays the ack.
  const onSubmissionStored = (receipt: SubmissionReceipt, sub: WitnessSubmission, fromDid: string): void => {
    void (async () => {
      const stored = await store.get(receipt.artefactId);
      const sensitivity = receipt.assignedSensitivity ?? stored?.sensitivity ?? Sensitivity.SEALED;
      const item: VaultItem = {
        id: receipt.artefactId,
        kind: sub.kind,
        sensitivity,
        sensitivityName: sensitivityName(sensitivity),
        observedAt: sub.observedAt,
        ...(stored?.scope ? { scope: stored.scope } : {}),
      };
      server.emit('submission-stored', { item, from: fromDid }, { owner: stored?.owner ?? config.sovereignDid, scope: stored?.scope });
    })();
  };

  // Wrap the real handler so a stored submission is pushed to connected consoles.
  const inner = makeWardenHandler(service, delegations, evidenceService, kbs, config.sovereignDid, {
    confirmAtOrBelow: config.confirmAtOrBelow,
    isAutofileTrusted,
  }, onSubmissionStored, challenges);
  const handler: RequestHandler = async (message, fromDid) => {
    // Inbound card from another node — VERIFY at receipt, then queue as PENDING-INBOUND (born obsidian;
    // promote into the vault only on the member's explicit accept — Sevenfold's model), emit `card-received`,
    // ack the sender. We NEVER import the shipped foreign ops into our own gatekeeper (B6): a cross-node card
    // is verified inside an ephemeral, peerless DMZ and only its verified closure (the `issued` leaf) is
    // kept — the raw ops are discarded. Accept later cannot shortcut the DMZ because the ops aren't retained.
    if (message.type === 'hearthold/credential-delivery') {
      const m = message as CredentialDeliveryMessage;
      const nativelyResolvable = await handle.keymaster
        .resolveDID(m.credentialDid)
        .then((d) => Boolean(d.didDocument?.id))
        .catch(() => false);
      let verified = false;
      let closure: IssuedLeaf | undefined;
      let versionId: string | undefined;
      let reason: string | undefined;
      let contentReadable: boolean | undefined;
      if (nativelyResolvable) {
        // Native (shared-registry / same node): resolvable on our OWN store, no import needed. Extract the
        // closure off our own store — verified iff we can read the credential to keep as the leaf.
        const vc = await handle.keymaster.getCredential(m.credentialDid).catch(() => null);
        if (vc) {
          verified = true;
          closure = buildIssuedLeaf(m.credentialDid, vc as ResolvedCredential);
          contentReadable = true;
        } else {
          reason = 'credential resolvable but its content was unreadable on this node';
        }
      } else if (openDmz) {
        // Cross-node: the ops are foreign. Verify in the ephemeral peerless DMZ and keep ONLY the closure.
        // The chain is the trust gate; a cross-audience VC yields a provenance-only closure (contentReadable
        // false) — still acceptable. See verifyForeignCredential.
        const res = await verifyForeignCredential(openDmz, m);
        verified = res.ok;
        closure = res.leaf;
        versionId = res.versionId;
        reason = res.reason;
        contentReadable = res.contentReadable;
      } else {
        reason =
          'VC not resolvable on this node and no DMZ configured (HEARTHOLD_DMZ_URL) — refusing to import foreign ops to verify it (fail closed)';
      }
      // Readable handover: if the sender shipped a recipient-sealed rendering (opt-in `readable` pass), unseal
      // it with OUR key (it was sealed to us, the delivery target) and enrich the chain-verified closure with
      // the readable claims. Best-effort — a blob we can't decrypt leaves the provenance closure untouched.
      if (verified && closure && m.recipientSealed) {
        try {
          const rendering = JSON.parse(await unsealAsWarden(handle, m.recipientSealed)) as {
            claims?: Record<string, unknown>;
            credentialType?: string;
            subject?: string;
          };
          if (rendering.claims) {
            closure = {
              ...closure,
              claims: rendering.claims,
              ...(rendering.credentialType ? { credentialType: rendering.credentialType } : {}),
              ...(rendering.subject ? { subject: rendering.subject } : {}),
            };
            contentReadable = true;
          }
        } catch {
          /* can't decrypt the rendering → keep the provenance closure as-is */
        }
      }
      // Issuer authenticity: a peerless DMZ only proves the chain is internally consistent — the issuer was
      // SENDER-ASSERTED (shipped in the ops), so a forged-issuer sender could reach verified:true. Cross-check
      // the issuer against OUR OWN federated resolution (our real gatekeeper, NOT the DMZ): resolves ⇒ the
      // issuer is an independently-known identity (issuer-authentic); else it is only chain-consistent and the
      // member decides whether to trust it. We surface both so the accept is an informed trust decision.
      let authenticity: CardAuthenticity | undefined;
      if (verified && closure) {
        const issuerResolves = await handle.keymaster
          .resolveDID(closure.issuer)
          .then((d) => Boolean(d.didDocument?.id))
          .catch(() => false);
        authenticity = issuerResolves ? 'issuer-authentic' : 'chain-consistent';
      }
      const card: StoredInboundCard = {
        credentialDid: m.credentialDid,
        schemaDid: m.schemaDid,
        from: String(fromDid).split('#')[0] ?? '',
        verified,
        receivedAt: new Date().toISOString(),
        owner: config.sovereignDid ?? id.did, // v1 home-plane recipient; per-member routing by VC subject is a follow-up
        ...(closure ? { closure, issuer: closure.issuer } : {}),
        ...(authenticity ? { authenticity } : {}),
        ...(contentReadable !== undefined ? { contentReadable } : {}),
        ...(versionId ? { versionId } : {}),
      };
      inboundCards.put(card);
      // The wire event carries only the CardReceivedEvent fields — the closure stays server-side.
      const { closure: _cl, versionId: _vid, ...wire } = card;
      server.emit('card-received', wire as CardReceivedEvent, { owner: card.owner });
      const ack: CredentialDeliveryAckMessage = {
        type: 'hearthold/credential-delivery-ack',
        version: PROTOCOL_VERSION,
        credentialDid: m.credentialDid,
        accepted: verified,
        ...(verified ? {} : { reason: reason ?? 'queued as unverified pending-inbound' }),
      };
      return ack;
    }

    // A witness submission is ack'd immediately by `inner` ("received & queued"); the `submission-stored` SSE
    // fires later from `onSubmissionStored` when the background caption/classify/store lands the artefact.
    return inner(message, fromDid);
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
