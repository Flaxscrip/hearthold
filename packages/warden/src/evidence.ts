/**
 * The Warden's evidence flow: turn a claim + the Sovereign's witnessed vault data into a signed,
 * presentable evidence graph.
 *
 * Selects the artefacts that back the claim, runs the release decision over their sensitivity, and
 * either mints the graph (trust class `witnessed`) or steps up. STANDING clears ≤LOW directly; for
 * MEDIUM/HIGH/SEALED the Warden obtains the Sovereign's signed proof-of-human approval on a **direct
 * Warden↔Sovereign channel** (the Witness is never in the authorization path — §7.7). If no direct
 * approver is wired, it falls back to a requester-driven `step-up-required`.
 */

import { randomUUID } from 'node:crypto';

import {
  assembleEvidence,
  mintEvidenceGraph,
  verifyEvidenceApproval,
  requiredLevelFor,
  decideRelease,
  requiredTier,
  AuthzTier,
  PROTOCOL_VERSION,
  type ArtefactMeta,
  type EvidenceRequest,
  type EvidenceResponse,
  type ApprovalRequestMessage,
  type ApprovalResponseMessage,
  type HearthholdConfig,
  type KeymasterHandle,
  type Sensitivity,
} from '@hearthold/core';

import { VaultStore, type Artefact } from './store.js';

/**
 * The Warden's direct channel to the Sovereign for a step-up. Implemented over DIDComm in the control
 * daemon (`transport.request(sovereignDid, …)`); an in-process function in tests. The Witness is not
 * involved — this is the control plane, owned by the Warden.
 */
export interface SovereignApprover {
  requestApproval(req: ApprovalRequestMessage): Promise<ApprovalResponseMessage>;
}

const toMeta = (a: Artefact): ArtefactMeta => ({
  id: a.id,
  kind: a.kind,
  observedAt: a.observedAt,
  sensitivity: a.sensitivity,
  witnessedBy: a.metadata?.witness as string | undefined,
});

export class EvidenceService {
  private readonly store: VaultStore;

  constructor(
    private readonly warden: KeymasterHandle,
    private readonly config: HearthholdConfig,
    /** Direct channel to the Sovereign for a step-up. When absent, sensitive claims step-up-required. */
    private readonly approver?: SovereignApprover,
  ) {
    this.store = new VaultStore(warden.dataFolder);
  }

  async handle(
    req: EvidenceRequest,
    fromDid: string,
    delegationValid: boolean,
  ): Promise<EvidenceResponse> {
    const deny = (reason: string): EvidenceResponse => ({
      type: 'hearthold/evidence-response',
      version: PROTOCOL_VERSION,
      status: 'denied',
      reason,
    });

    if (!req.spec) return deny('evidence request needs a claim spec (kind + optional window)');
    if (!delegationValid) return deny('no valid delegation for this requester');

    const metas = (await this.store.list()).map(toMeta);
    const assembled = assembleEvidence(metas, req.spec);
    if (!assembled) return deny(`no supporting ${req.spec.kind} artefacts back that claim`);

    const sensitivity = assembled.sensitivity as Sensitivity;
    const subjectDid = req.subjectDid ?? this.config.sovereignDid ?? fromDid;
    const evidenceRoot = assembled.group.commitment.merkleRoot;
    const validUntil = new Date(Date.now() + 1000 * 60 * 10).toISOString();
    const mint = (approval?: Parameters<typeof mintEvidenceGraph>[1]['approval']) =>
      mintEvidenceGraph(this.warden, {
        subjectDid,
        claim: req.claim,
        structured: req.spec?.structured,
        evidence: [assembled.group],
        txn: approval?.txn ?? randomUUID(),
        validUntil,
        approval,
      });
    const granted = async (
      approval?: Parameters<typeof mintEvidenceGraph>[1]['approval'],
    ): Promise<EvidenceResponse> => {
      const { credentialDid, schemaDid } = await mint(approval);
      return { type: 'hearthold/evidence-response', version: PROTOCOL_VERSION, status: 'granted', credentialDid, schemaDid };
    };

    // STANDING clears up to LOW → mint directly (A1).
    const standingClears = decideRelease({
      sensitivity,
      tier: AuthzTier.STANDING,
      delegationValid,
      mode: req.disclosureMode,
      disclosureSatisfiable: true,
    }).allow;
    if (standingClears) return granted();

    // Sensitive (MEDIUM/HIGH/SEALED): the disclosure needs the Sovereign's proof-of-human approval.
    const requiredLevel = requiredLevelFor(sensitivity);

    // Primary path: the WARDEN obtains the approval directly from the Sovereign (Witness not involved).
    if (this.approver) {
      const txn = randomUUID();
      const ares = await this.approver.requestApproval({
        type: 'hearthold/approval-request',
        version: PROTOCOL_VERSION,
        txn,
        claim: req.claim,
        evidenceRoot,
        requiredLevel,
        reason: `Disclose “${req.claim}” — backed by ${assembled.group.count} witnessed ${req.spec.kind} observation(s)`,
        subjectDid,
      });
      if (!ares.approved) return deny(`disclosure declined by the Sovereign: ${ares.reason}`);
      const check = await verifyEvidenceApproval(this.warden, ares.approvalCredDid, {
        approver: subjectDid,
        claim: req.claim,
        evidenceRoot,
        requiredLevel,
      });
      if (!check.ok) return deny(`approval verification failed: ${check.reason}`);
      return granted({
        approver: check.approver as string,
        txn: check.txn ?? txn,
        humanProof: check.humanProof as { method: string; level: number; timestamp: string },
      });
    }

    // Fallback: no direct channel wired → requester-driven step-up.
    if (!req.stepUp) {
      return {
        type: 'hearthold/evidence-response',
        version: PROTOCOL_VERSION,
        status: 'step-up-required',
        requiredTier: requiredTier(sensitivity),
        accepts: ['challenge'],
        context: { txn: randomUUID(), claim: req.claim, evidenceRoot, requiredLevel },
      };
    }
    const check = await verifyEvidenceApproval(this.warden, req.stepUp.value, {
      approver: subjectDid,
      claim: req.claim,
      evidenceRoot,
      requiredLevel,
    });
    if (!check.ok) return deny(`step-up rejected: ${check.reason}`);
    return granted({
      approver: check.approver as string,
      txn: check.txn ?? randomUUID(),
      humanProof: check.humanProof as { method: string; level: number; timestamp: string },
    });
  }
}
