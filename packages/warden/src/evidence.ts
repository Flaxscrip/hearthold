/**
 * The Warden's evidence flow: turn a claim + the Sovereign's witnessed vault data into a signed,
 * presentable evidence graph.
 *
 * Selects the artefacts that back the claim, runs the release decision over their sensitivity, and
 * either mints the graph (trust class `witnessed`) or demands a step-up. A1 grants up to the
 * requester's standing clearance; HIGH/SEALED returns `step-up-required` (the Sovereign co-sign via
 * the Signet is A2).
 */

import { randomUUID } from 'node:crypto';

import {
  assembleEvidence,
  mintEvidenceGraph,
  decideRelease,
  requiredTier,
  AuthzTier,
  PROTOCOL_VERSION,
  type ArtefactMeta,
  type EvidenceRequest,
  type EvidenceResponse,
  type HearthholdConfig,
  type KeymasterHandle,
  type Sensitivity,
} from '@hearthold/core';

import { VaultStore, type Artefact } from './store.js';

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
    // A1: a delegated Witness acts at STANDING. Step-up to a higher tier is A2.
    const decision = decideRelease({
      sensitivity,
      tier: AuthzTier.STANDING,
      delegationValid,
      mode: req.disclosureMode,
      disclosureSatisfiable: true,
    });

    if (!decision.allow) {
      return {
        type: 'hearthold/evidence-response',
        version: PROTOCOL_VERSION,
        status: 'step-up-required',
        requiredTier: requiredTier(sensitivity),
        accepts: ['challenge', 'pin'],
      };
    }

    const subjectDid = req.subjectDid ?? this.config.sovereignDid ?? fromDid;
    const { credentialDid, schemaDid } = await mintEvidenceGraph(this.warden, {
      subjectDid,
      claim: req.claim,
      structured: req.spec.structured,
      evidence: [assembled.group],
      txn: randomUUID(),
      validUntil: new Date(Date.now() + 1000 * 60 * 10).toISOString(),
    });
    return {
      type: 'hearthold/evidence-response',
      version: PROTOCOL_VERSION,
      status: 'granted',
      credentialDid,
      schemaDid,
    };
  }
}
