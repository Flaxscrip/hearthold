/**
 * The Warden's evidence flow: turn a claim + the Sovereign's witnessed vault data into a signed,
 * presentable evidence graph.
 *
 * Selects the artefacts that back the claim, runs the release decision over their sensitivity, and
 * either mints the graph (trust class `witnessed`) or steps up. STANDING clears ≤LOW directly; for
 * MEDIUM/HIGH/SEALED the Warden obtains the Sovereign's signed proof-of-human approval on a **direct
 * Warden↔Sovereign channel** (the Witness is never in the authorization path — §7.7). Without a
 * Sovereign channel wired, a sensitive claim is denied.
 */

import { randomUUID } from 'node:crypto';

import {
  assembleEvidence,
  mintEvidenceGraph,
  verifyEvidenceApproval,
  requiredLevelFor,
  decideRelease,
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
    /** Direct channel to the Sovereign for a step-up. When absent, sensitive claims are denied. */
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
    // Ephemeral proof: expires after the requested window (Archon's validUntil), default 10 min.
    const ttlMin = req.validForMinutes && req.validForMinutes > 0 ? req.validForMinutes : 10;
    const validUntil = new Date(Date.now() + ttlMin * 60_000).toISOString();
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
      const g = assembled.group;
      return {
        type: 'hearthold/evidence-response',
        version: PROTOCOL_VERSION,
        status: 'granted',
        credentialDid,
        schemaDid,
        graph: {
          claim: req.claim,
          structured: req.spec?.structured,
          evidence: [
            {
              kind: g.kind,
              observedFrom: g.observedFrom,
              observedTo: g.observedTo,
              count: g.count,
              witnessedBy: g.witnessedBy,
              merkleRoot: g.commitment.merkleRoot,
            },
          ],
          approved: Boolean(approval),
          validUntil,
        },
      };
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
      const check = await verifyEvidenceApproval(this.warden, ares.approval, {
        approver: subjectDid,
        claim: req.claim,
        evidenceRoot,
        requiredLevel,
      });
      if (!check.ok) return deny(`approval verification failed: ${check.reason}`);
      return granted(ares.approval);
    }

    // No direct channel to the Sovereign wired → this sensitive disclosure can't be co-signed here.
    return deny('sensitive claim needs a Sovereign approval channel — set HEARTHOLD_SOVEREIGN_DID on the Warden');
  }
}
