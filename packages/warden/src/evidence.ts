/**
 * The Warden's evidence flow: turn a claim + the Sovereign's witnessed vault data into a signed,
 * presentable evidence graph.
 *
 * Selects the artefacts that back the claim, runs the release decision over their sensitivity, and
 * either mints the graph (trust class `witnessed`) or steps up. STANDING clears ≤LOW directly; for
 * MEDIUM/HIGH/SEALED the Warden obtains the Sovereign's signed proof-of-human approval on a **direct
 * Warden↔Sovereign channel** (the Emissary is never in the authorization path — §7.7). Without a
 * Sovereign channel wired, a sensitive claim is denied.
 */

import { randomUUID } from 'node:crypto';

import {
  assembleEvidence,
  revealLeaves,
  mintEvidenceGraph,
  verifyEvidenceApproval,
  requiredLevelFor,
  decideRelease,
  verifyInvocation,
  FileSpentTxnStore,
  IssuedStore,
  AuthzTier,
  PROTOCOL_VERSION,
  type ArtefactMeta,
  type IssuedLeafRef,
  type EvidenceRequest,
  type EvidenceClaimSpec,
  type CapabilityInvocation,
  type Discharge,
  type DischargeRequest,
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
 * daemon (`transport.request(sovereignDid, …)`); an in-process function in tests. The Emissary is not
 * involved — this is the control plane, owned by the Warden.
 */
export interface SovereignApprover {
  requestApproval(req: ApprovalRequestMessage): Promise<ApprovalResponseMessage>;
}

/**
 * The Warden's channel to a DESIGNATED Signet to obtain a consent discharge (the Phase-3 capability step-up).
 * Implemented over DIDComm in the daemon (`transport.request(cav.by, …)`); in-process in tests. The Emissary
 * is never involved — consent routes to the owner's own device, and the discharge is bound to the act's txn.
 */
export interface DischargeRequester {
  requestDischarge(req: DischargeRequest): Promise<Discharge | null>;
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
    /** Channel to a designated Signet for a consent discharge (the capability step-up). When absent, a
     *  capability that requires a discharge is denied. */
    private readonly dischargeRequester?: DischargeRequester,
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

    // A3 selective disclosure: reveal the requested observations against the signed Merkle root.
    if (req.reveal && req.reveal.length > 0) {
      assembled.group.revealed = revealLeaves(assembled, req.reveal);
      assembled.group.disclosure = 'selective';
    }

    const sensitivity = assembled.sensitivity as Sensitivity;
    // The APPROVER (forger) co-signs the disclosure at their own Signet and is the approval's expected signer.
    const subjectDid = req.subjectDid ?? this.config.sovereignDid ?? fromDid;
    // The credential-BINDING subject: bind to the recipient (forge-for-a-recipient) so THEY can read the
    // scroll, else to the approver (forge for self). The approval below is always by `subjectDid` (the forger).
    const bindSubject = req.recipientDid ?? subjectDid;
    const evidenceRoot = assembled.group.commitment.merkleRoot;
    // Ephemeral proof: expires after the requested window (Archon's validUntil), default 10 min.
    const ttlMin = req.validForMinutes && req.validForMinutes > 0 ? req.validForMinutes : 10;
    const validUntil = new Date(Date.now() + ttlMin * 60_000).toISOString();

    // Compose third-party `issued` leaves the requester named — the strongest evidence class.
    const issuedLeaves: IssuedLeafRef[] = [];
    if (req.with && req.with.length > 0) {
      const store = new IssuedStore(this.warden.dataFolder);
      for (const did of req.with) {
        const leaf = await store.get(did);
        if (!leaf) return deny(`issued credential not in the vault: ${did.slice(0, 24)}…`);
        if (leaf.status === 'revoked') return deny(`issued credential is revoked: ${did.slice(0, 24)}…`);
        issuedLeaves.push({
          id: `urn:hearthold:issued:${did.slice(-8)}`,
          type: ['HearthholdIssuedLeaf'],
          trustClass: 'issued',
          credentialDid: did,
          issuer: leaf.issuer,
          schema: leaf.schema,
          credentialType: leaf.credentialType,
          descriptionSource: 'issuer-asserted',
        });
      }
    }

    const mint = (approval?: Parameters<typeof mintEvidenceGraph>[1]['approval']) =>
      mintEvidenceGraph(this.warden, {
        subjectDid: bindSubject, // bind to the recipient (forge-for) or the forger (self); NOT the approver role
        claim: req.claim,
        structured: req.spec?.structured,
        evidence: [assembled.group],
        issuedLeaves,
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
          trustClass: issuedLeaves.length > 0 ? 'composite' : 'witnessed',
          issued: issuedLeaves.map((l) => ({ issuer: l.issuer, credentialType: l.credentialType, schema: l.schema })),
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

    // Primary path: the WARDEN obtains the approval directly from the Sovereign (Emissary not involved).
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

  /**
   * Phase 2 capability path: authorize a disclosure by a presented CAPABILITY, verified at the point of use,
   * instead of the requester-supplied `subjectDid` + a delegation boolean. The owner scope AND the recipient
   * come from the capability — never from the request — which closes the confused-deputy step-up (finding A)
   * and the whole-vault `store.list()` leak. The legacy `handle()` path above is untouched (back-compat).
   */
  async handleInvocation(inv: CapabilityInvocation, fromDid: string): Promise<EvidenceResponse> {
    const deny = (reason: string): EvidenceResponse => ({
      type: 'hearthold/evidence-response',
      version: PROTOCOL_VERSION,
      status: 'denied',
      reason,
    });
    const leaf = inv.capability.credentialSubject;
    const args = (inv.act.args ?? {}) as { claim?: string; spec?: EvidenceClaimSpec; reveal?: number[] };
    if (!args.claim) return deny('invocation act.args is missing the claim');
    if (!args.spec) return deny('invocation act.args is missing the claim spec');
    const spec = args.spec;

    const owner = leaf.caveats.owner ?? this.config.sovereignDid;
    if (!owner) return deny('capability names no owner scope');

    // OWNER-SCOPED assembly — only this owner's artefacts (closes the whole-vault store.list() leak).
    const scoped = (await this.store.list()).filter((a) => (a.owner ?? this.config.sovereignDid) === owner);
    const assembled = assembleEvidence(scoped.map(toMeta), spec);
    if (!assembled) return deny(`no supporting ${spec.kind} artefacts (owned by the capability's subject) back that claim`);
    if (args.reveal && args.reveal.length > 0) {
      assembled.group.revealed = revealLeaves(assembled, args.reveal);
      assembled.group.disclosure = 'selective';
    }
    const sensitivity = assembled.sensitivity as Sensitivity;

    // The reference monitor — the point-of-use check: binds the presented capability to its on-chain
    // commitments, checks the act ⊆ authority, the ceiling, replay (single-use txn), and consent discharges.
    const ctx = {
      keymaster: this.warden,
      fromDid,
      expectedRootIssuer: this.config.sovereignDid ?? owner,
      disclosed: inv.disclosed ?? {},
      orderedCaveats: inv.orderedCaveats ?? [],
      spent: new FileSpentTxnStore(this.warden.dataFolder),
      sensitivity,
    };
    let decision = await verifyInvocation(inv, ctx);

    // Consent step-up (MEDIUM+): the Warden obtains a discharge from the DESIGNATED Signet — never via the
    // Emissary — bound to this act's txn, then retries. The macaroon third-party caveat made real; this is
    // what replaces the requester-chosen approver at high sensitivity.
    if (!decision.allow && decision.needsDischarge && decision.needsDischarge.length > 0) {
      if (!this.dischargeRequester) return deny('this disclosure needs a consent discharge but no discharge channel is wired');
      const discharges: Discharge[] = [...(inv.discharges ?? [])];
      for (const need of decision.needsDischarge) {
        const d = await this.dischargeRequester.requestDischarge({
          txn: inv.act.txn,
          by: need.by,
          predicate: need.predicate,
          claim: args.claim,
          reason: `Disclose “${args.claim}” — ${spec.kind}`,
          sensitivity,
        });
        if (!d) return deny('consent declined at the Signet');
        discharges.push(d);
      }
      decision = await verifyInvocation({ ...inv, discharges }, ctx);
    }
    if (!decision.allow) return deny(`invocation refused: ${decision.reason}`);

    // Bind the scroll to the capability's audience (forge-for-a-recipient), else to the holder — NEVER a
    // requester-chosen recipient (the other half of finding A).
    const bindSubject = leaf.caveats.audience ?? fromDid;
    const validUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const { credentialDid, schemaDid } = await mintEvidenceGraph(this.warden, {
      subjectDid: bindSubject,
      claim: args.claim,
      structured: spec.structured,
      evidence: [assembled.group],
      issuedLeaves: [],
      txn: inv.act.txn,
      validUntil,
    });
    const g = assembled.group;
    return {
      type: 'hearthold/evidence-response',
      version: PROTOCOL_VERSION,
      status: 'granted',
      credentialDid,
      schemaDid,
      graph: {
        claim: args.claim,
        structured: spec.structured,
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
        approved: false,
        validUntil,
        trustClass: 'witnessed',
        issued: [],
      },
    };
  }
}
