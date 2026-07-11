/**
 * The Warden's CGPR service — the A-side backend behind the A2A gateway.
 *
 * The gateway (Emissary-plane, holds no secrets) translates an inbound A2A `CgprRequestArtifact` into a
 * neutral internal request and hands it here. This service is A2A-agnostic: it authorizes the gateway
 * *actor* against its Sovereign-signed Ruleset (constraint #3), authors the consent text itself
 * (constraint #4 — never the requesting agent), crosses the deny-by-default release ladder unchanged
 * (constraint #6), and mints the disclosure as a scoped, single-use attestation bound to a FRESH
 * pairwise DID for the counterparty (H1). It returns a neutral result the gateway shapes into a
 * `CgprGrant`/`CgprDecision` — so no A2A type reaches the Warden or core.
 */

import { randomUUID } from 'node:crypto';

import {
  assembleEvidence,
  decideRelease,
  authorizeActor,
  activeRuleset,
  mintPairwiseGrant,
  acceptCredential,
  pairwiseName,
  requiredLevelFor,
  AuthzTier,
  PROTOCOL_VERSION,
  type SignedRuleset,
  type PairwiseStore,
  type KeymasterHandle,
  type HearthholdConfig,
  type EvidenceClaimSpec,
  type ArtefactMeta,
  type Sensitivity,
  type WitnessKind,
} from '@hearthold/core';

import { VaultStore, type Artefact } from './store.js';
import type { SovereignApprover } from './evidence.js';

const toMeta = (a: Artefact): ArtefactMeta => ({
  id: a.id,
  kind: a.kind,
  observedAt: a.observedAt,
  sensitivity: a.sensitivity,
  witnessedBy: a.metadata?.witness as string | undefined,
});

/** The neutral internal request the gateway translates a `CgprRequestArtifact` into (no A2A types). */
export interface CgprRequestInternal {
  /** The counterparty (C) — its DID; the pairwise mint audience and the grant recipient. */
  audience: string;
  /** HATPro vocabulary paths, e.g. "foodAndBeverage.dietaryRestrictions". */
  scopes: string[];
  purpose: string;
  validForMinutes: number;
}

export interface CgprGrantResult {
  status: 'granted';
  /** The attestation VC, subject = the fresh pairwise DID. */
  credential: Record<string, unknown>;
  credentialDid: string;
  schemaDid: string;
  subjectDid: string;
  validUntil: string;
  /** The Warden-authored consent text (constraint #4). */
  reason: string;
}
export interface CgprDenyResult {
  status: 'denied';
  reason: string;
}
export type CgprResult = CgprGrantResult | CgprDenyResult;

export interface CgprServiceOptions {
  /** The gateway actor's Sovereign-signed Ruleset chain (constraint #3). */
  gatewayRuleset: SignedRuleset[];
  /** The governing Sovereign: pins the Ruleset signer and is the subject behind each pairwise DID. */
  sovereignDid: string;
  pairwiseStore: PairwiseStore;
  /** Vault kind that backs preference claims (HATPro profiles are `document`s). Default `document`. */
  kind?: WitnessKind;
  /** Signet channel for MEDIUM+ scopes; LOW clears at STANDING without it (existing machinery). */
  approver?: SovereignApprover;
}

export class CgprService {
  private readonly store: VaultStore;

  constructor(
    private readonly warden: KeymasterHandle,
    private readonly config: HearthholdConfig,
    private readonly opts: CgprServiceOptions,
  ) {
    this.store = new VaultStore(warden.dataFolder);
  }

  async handle(req: CgprRequestInternal): Promise<CgprResult> {
    const deny = (reason: string): CgprDenyResult => ({ status: 'denied', reason });
    const kind: WitnessKind = this.opts.kind ?? 'document';

    // 1. Assemble the witnessed evidence backing the requested scopes.
    const spec: EvidenceClaimSpec = { kind, structured: { scopes: req.scopes } };
    const metas = (await this.store.list()).map(toMeta);
    const assembled = assembleEvidence(metas, spec);
    if (!assembled) return deny(`no witnessed ${kind} artefacts back these scopes`);
    const sensitivity = assembled.sensitivity as Sensitivity;

    // 2. Governance: the gateway actor must be authorized by its active, Sovereign-signed Ruleset.
    const authz = await authorizeActor(
      this.warden,
      this.opts.gatewayRuleset,
      { verb: 'grant', kind, sensitivity },
      { expectedSigner: this.opts.sovereignDid },
    );
    if (!authz.allowed) return deny(`gateway not authorized: ${authz.reason}`);
    const active = await activeRuleset(this.warden, this.opts.gatewayRuleset, { expectedSigner: this.opts.sovereignDid });

    // 3. The Warden authors the consent text — never the requesting agent (constraint #4, §7.7).
    const reason =
      `Disclose ${req.scopes.join(', ')} to ${req.audience.slice(0, 24)}… for: ${req.purpose} — ` +
      `backed by ${assembled.group.count} witnessed ${kind} observation(s)`;

    const claim = `Holds preferences: ${req.scopes.join(', ')}`;
    const ttlMin = req.validForMinutes > 0 ? req.validForMinutes : 10;
    const validUntil = new Date(Date.now() + ttlMin * 60_000).toISOString();

    // 4. Release ladder (unchanged). LOW clears at STANDING; MEDIUM+ needs the Signet.
    const standingClears = decideRelease({
      sensitivity,
      tier: AuthzTier.STANDING,
      delegationValid: true,
      mode: 'ATTESTATION',
      disclosureSatisfiable: true,
    }).allow;

    let approval: Parameters<typeof mintPairwiseGrant>[2]['approval'];
    if (!standingClears) {
      if (!this.opts.approver) return deny('sensitive scope needs a Sovereign approval channel (Signet)');
      const txn = randomUUID();
      const ares = await this.opts.approver.requestApproval({
        type: 'hearthold/approval-request',
        version: PROTOCOL_VERSION,
        txn,
        claim,
        evidenceRoot: assembled.group.commitment.merkleRoot,
        requiredLevel: requiredLevelFor(sensitivity),
        reason,
        subjectDid: this.opts.sovereignDid,
      });
      if (!ares.approved) return deny(`disclosure declined by the Sovereign: ${ares.reason}`);
      approval = ares.approval;
    }

    // 5. Mint the grant to a FRESH pairwise DID for this counterparty (H1). The gateway's active
    //    Ruleset governs both the actor authorization above and any stable-DID exception.
    const mint = await mintPairwiseGrant(this.warden, this.opts.pairwiseStore, {
      audience: req.audience,
      sovereignDid: this.opts.sovereignDid,
      activeRuleset: active,
      createdAt: new Date().toISOString(),
      registry: this.config.registry,
      claim,
      structured: { scopes: req.scopes },
      evidence: [assembled.group],
      txn: approval?.txn ?? randomUUID(),
      validUntil,
      approval,
    });

    // 6. Resolve the issued VC as the pairwise holder (the Warden owns the pairwise id), so the gateway
    //    can hand C a verifiable credential. Restore the wallet's current id afterwards.
    const prev = await this.warden.keymaster.getCurrentId().catch(() => undefined);
    await this.warden.keymaster.setCurrentId(pairwiseName(req.audience));
    await acceptCredential(this.warden, mint.credentialDid);
    const credential = (await this.warden.keymaster.getCredential(mint.credentialDid)) as unknown as Record<string, unknown>;
    if (prev) await this.warden.keymaster.setCurrentId(prev);

    return {
      status: 'granted',
      credential,
      credentialDid: mint.credentialDid,
      schemaDid: mint.schemaDid,
      subjectDid: mint.subjectDid,
      validUntil,
      reason,
    };
  }
}
