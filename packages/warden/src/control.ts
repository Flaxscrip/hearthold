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
import { buildKbServices, KbConfigStore, setKbAssurance, readKbAssurance } from './kb-config.js';
import { makeWardenHandler } from './handler.js';

const sensitivityName = (s: number): SensitivityName => SENSITIVITY_NAMES[s] ?? 'SEALED';

const toVaultItem = (a: Artefact): VaultItem => ({
  id: a.id,
  kind: a.kind,
  sensitivity: a.sensitivity,
  sensitivityName: sensitivityName(a.sensitivity),
  observedAt: a.observedAt,
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

  // Direct Warden↔Sovereign approval channel: for a sensitive evidence disclosure (a forge of MEDIUM+
  // data), the Warden asks the Sovereign's Signet directly. Hoisted here so the /api/forge route and
  // the DIDComm evidence handler share ONE EvidenceService.
  const approver: SovereignApprover | undefined = config.sovereignDid
    ? {
        async requestApproval(req) {
          try {
            const reply = await transport.request(config.sovereignDid as string, req, { timeoutMs: 180_000 });
            if (reply.type === 'hearthold/approval-response') return reply;
            return { type: 'hearthold/approval-response', version: PROTOCOL_VERSION, approved: false, reason: `unexpected reply ${reply.type}` };
          } catch (err) {
            return { type: 'hearthold/approval-response', version: PROTOCOL_VERSION, approved: false, reason: `Sovereign unreachable: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }
    : undefined;
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

  const snapshot = async (): Promise<WardenSnapshot> => ({
    status: await status(),
    vault: (await store.list()).map(toVaultItem),
    delegations: await delegations.list(),
  });

  const server = startControlServer({
    port,
    routes: {
      'GET /api/status': async () => ({ status: await status() }),
      'GET /api/snapshot': async () => await snapshot(),
      'POST /api/delegate': async ({ body }) => {
        const { witnessDid } = (body ?? {}) as DelegateRequest;
        if (!witnessDid) throw new Error('witnessDid is required');
        const schemaDid = await ensureDelegationSchema(handle);
        const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
        const credentialDid = await issueDelegation(handle, witnessDid, schemaDid, {
          kinds: ['event', 'location', 'activity', 'browsing', 'document'],
          validUntil,
        });
        await delegations.record(witnessDid, credentialDid);
        server.emit('delegation-issued', { subjectDid: witnessDid, credentialDid });
        return { subjectDid: witnessDid, credentialDid };
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
      'POST /api/recall': async ({ body }) => {
        const { query, k } = (body ?? {}) as RecallRequest;
        if (!query) throw new Error('query is required');
        // Private RAG over the vault — the query, retrieval, and answer all stay on this device.
        const result = await RecallService.forWarden(handle, config).recall(query, k ? { k } : {});
        return { result };
      },
      // Forge (Sevenfold) — mint an Attestation scroll from a divination. Reuses the evidence flow: a
      // MEDIUM+ forge triggers the same out-of-band Signet evidence-approval the DIDComm path uses;
      // LOW/witnessed clears at STANDING with no step-up. The browser holds no key.
      'POST /api/forge': async ({ body }) => {
        const { claim, kind, from, to, structured, validForMinutes } = (body ?? {}) as ProveRequest;
        if (!claim || !kind) throw new Error('claim and kind are required');
        const at = new Date().toISOString();
        const req: EvidenceRequest = {
          type: 'hearthold/evidence-request',
          version: PROTOCOL_VERSION,
          claim,
          disclosureMode: 'ATTESTATION',
          spec: { kind: kind as never, from, to, structured },
          ...(config.sovereignDid ? { subjectDid: config.sovereignDid } : {}),
          ...(validForMinutes ? { validForMinutes } : {}),
        };
        // Home-plane forge: the Sovereign proves from their own vault (delegationValid = true).
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
          server.emit('scroll-forged', { proof });
        }
        return { proof };
      },
      // Present (Sevenfold) — play the scroll; it BURNS. Single-use enforced verifier-side (the holder
      // can't reset it). Home-plane demonstration; cross-party presentation stays Witness-side.
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
      // (obsidian), not an error. The face is unsealed transiently and never cached (G2).
      'POST /api/card/face': async ({ body }) => {
        const { artefactId, tier } = (body ?? {}) as CardFaceRequest;
        if (!artefactId) throw new Error('artefactId is required');
        const t = (tier ?? AuthzTier.STANDING) as AuthzTier;
        const card = await hydrateCardFace(handle, { artefactId, tier: t });
        return { card };
      },

      // Triage — the born-obsidian confirmation queue.
      'GET /api/triage': async () => ({ queue: await triageQueue(handle) }),
      'POST /api/triage/confirm': async ({ body }) => {
        const { artefactId, sensitivity } = (body ?? {}) as TriageConfirmRequest;
        if (!artefactId || sensitivity === undefined) throw new Error('artefactId and sensitivity are required');
        const item = await confirmTriage(handle, { artefactId, sensitivity: sensitivity as Sensitivity });
        server.emit('triage-confirmed', { item });
        return { item };
      },

      // SevenfoldMark — explicit claim; the Warden re-counts and issues (axes-free).
      'POST /api/marks/claimable': async ({ body }) => {
        const { candidates } = (body ?? {}) as { candidates?: MarkCandidate[] };
        return { marks: await claimableMarks(handle, candidates ?? []) };
      },
      'POST /api/marks/claim': async ({ body }) => {
        const { candidate, subjectDid } = (body ?? {}) as MarkClaimRequest;
        if (!candidate || !subjectDid) throw new Error('candidate and subjectDid are required');
        const result = await claimMark(handle, { candidate, subjectDid });
        if (result.issued) server.emit('mark-issued', { result });
        return { result };
      },

      // ── Knowledge Base membership + assurance policy (many KBs per Warden) ──
      // NB: KB access is granted to the *member* DID (the one that signs in), never to the relaying
      // Mage/Witness — the Warden authorizes the member, the Mage only carries.
      'GET /api/kb': async () => ({ kbs: await kbList() }),
      'POST /api/kb/grant': async ({ body }) => {
        const { kbId, did, scope } = (body ?? {}) as KbGrantRequest;
        const kb = await kbStore.get(kbId);
        if (!kb) throw new Error(`unknown KB "${kbId}"`);
        if (!did) throw new Error('did is required');
        if (scope === 'read' || scope === 'both') await grantAuthorization(handle, kb.readGroup, did);
        if (scope === 'write' || scope === 'both') await grantAuthorization(handle, kb.writeGroup, did);
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
  const inner = makeWardenHandler(service, delegations, evidenceService, kbs);
  const handler: RequestHandler = async (message, fromDid) => {
    const result = await inner(message, fromDid);
    if (
      result &&
      (result as { type?: string }).type === 'hearthold/submission-receipt' &&
      message.type === 'hearthold/witness-submission'
    ) {
      const receipt = result as SubmissionReceipt;
      const sub = message as WitnessSubmission;
      const item: VaultItem = {
        id: receipt.artefactId,
        kind: sub.kind,
        sensitivity: receipt.assignedSensitivity,
        sensitivityName: sensitivityName(receipt.assignedSensitivity),
        observedAt: sub.observedAt,
      };
      server.emit('submission-stored', { item, from: fromDid });
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
