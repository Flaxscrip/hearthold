/**
 * The Warden's evidence flow: turn a claim + the Sovereign's witnessed vault data into a signed,
 * presentable evidence graph.
 *
 * Selects the artefacts that back the claim, runs the release decision over their sensitivity, and either
 * mints the graph (trust class `witnessed`) or steps up. The human gate is a WARDEN POLICY, not an issuer
 * option: a disclosure at/above `config.requiresHumanAt` (default MEDIUM) requires the OWNER's fresh signed
 * consent (a discharge) obtained on a **direct Warden↔Signet channel** — the Emissary is never in the
 * authorization path (§7.7). Without a discharge channel wired, a sensitive disclosure is denied (fail-closed),
 * so a `ceiling: SEALED` capability with no `requiresDischarge` caveat cannot disclose SEALED with no human.
 */

import {
  assembleEvidence,
  revealLeaves,
  mintEvidenceGraph,
  resolveInvocation,
  resolveChainInvocation,
  authorizeInvocation,
  ensureAuthorizationSchema,
  FileSpentTxnStore,
  PROTOCOL_VERSION,
  type ArtefactMeta,
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
  type Transport,
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

/**
 * A DischargeRequester backed by DIDComm: the Warden asks the DESIGNATED owner's Signet (`req.by`) directly to
 * co-sign a sensitive disclosure, on the control-plane channel. The Emissary is never on it (§7.7). Times out
 * (→ null, denied) if the Signet doesn't answer — fail closed. Mirrors `makeDidcommActionApprover` (kb.ts).
 */
export function makeDidcommDischargeRequester(transport: Transport, timeoutMs = 170_000): DischargeRequester {
  return {
    async requestDischarge(req) {
      try {
        const reply = await transport.request(
          req.by,
          { type: 'hearthold/discharge-request', version: PROTOCOL_VERSION, request: req },
          { timeoutMs },
        );
        if (reply.type === 'hearthold/discharge-response' && reply.approved && reply.discharge) return reply.discharge;
        return null;
      } catch {
        return null; // unreachable Signet / timeout ⇒ not discharged (fail closed)
      }
    },
  };
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
    /** Channel to a designated Signet for a consent discharge (the capability step-up). When absent, a
     *  capability that requires a discharge is denied. */
    private readonly dischargeRequester?: DischargeRequester,
  ) {
    this.store = new VaultStore(warden.dataFolder);
  }

  /**
   * Authorize a disclosure by a presented CAPABILITY, verified at the point of use. The owner scope AND the
   * recipient come from the capability — never from the request — which closes the confused-deputy step-up
   * (finding A) and the whole-vault `store.list()` leak. This is the ONLY evidence-disclosure path.
   */
  async handleInvocation(
    inv: CapabilityInvocation,
    fromDid: string,
    /** Assert the presentation answered a fresh Warden-minted challenge (audit-3 §1). The handler passes
     *  `ChallengeStore.gate('invocation')`; a direct-library test may omit it. */
    requireChallenge?: (challenge: string) => boolean,
  ): Promise<EvidenceResponse> {
    const deny = (reason: string): EvidenceResponse => ({
      type: 'hearthold/evidence-response',
      version: PROTOCOL_VERSION,
      status: 'denied',
      reason,
    });
    const args = (inv.act.args ?? {}) as { claim?: string; spec?: EvidenceClaimSpec; reveal?: number[] };
    if (!args.claim) return deny('invocation act.args is missing the claim');
    if (!args.spec) return deny('invocation act.args is missing the claim spec');
    const spec = args.spec;

    // Resolve + AUTHENTICATE the capability FIRST. The enforced owner/ceiling/audience come from the
    // verified, commitment-bound chain, and the caller is bound to the holder by challenge/response — nothing
    // below trusts inv.capability.credentialSubject.
    // The same canonical schema DID the challenge requests + the Sovereign issues against (config in a
    // multi-wallet deployment; the Warden's own in single-wallet dev). All three must agree — see challenge-store.ts.
    const authorizationSchema = this.config.authorizationSchemaDid ?? (await ensureAuthorizationSchema(this.warden));
    const ctx = {
      keymaster: this.warden,
      fromDid,
      expectedRootIssuer: this.config.sovereignDid ?? '',
      authorizationSchema,
      spent: new FileSpentTxnStore(this.warden.dataFolder),
      requireStatus: this.config.requireRevocableCapabilities,
      ...(requireChallenge ? { requireChallenge } : {}),
    };
    // One resolve seam, two presentations: single-hop VC (verifyProof) OR a disclosed attenuation chain
    // (verifyCapabilityChain). BOTH return the same VerifiedLeaf, so everything below — owner scoping, evidence
    // assembly, authorizeInvocation (ceiling/expiry/replay/discharge/human-gate) — is identical (parity by
    // construction). The chain path carries its own per-hop revocation + Warden-challenge holder proof.
    const resolved = inv.chain ? await resolveChainInvocation(inv, ctx) : await resolveInvocation(inv, ctx);
    if (!resolved.ok) return deny(`invocation refused: ${resolved.reason}`);
    const leaf = resolved.leaf;
    const owner = leaf.caveats.owner ?? this.config.sovereignDid;
    if (!owner) return deny('capability names no owner scope');
    // Kind compartment: the requested kind must be granted by the capability's caveats. Leak-safe message.
    if (leaf.caveats.kinds && !leaf.caveats.kinds.includes(spec.kind)) return deny('not authorized to disclose the requested claim');

    // OWNER-SCOPED assembly — only the VERIFIED owner's artefacts (closes the whole-vault store.list() leak).
    const scoped = (await this.store.list()).filter((a) => (a.owner ?? this.config.sovereignDid) === owner);
    const assembled = assembleEvidence(scoped.map(toMeta), spec);
    // Leak-safe: identical to the ceiling denial below, so a below-clearance holder can't tell "no such
    // artefact" from "exists but above your ceiling".
    if (!assembled) return deny('not authorized to disclose the requested claim');
    if (args.reveal && args.reveal.length > 0) {
      assembled.group.revealed = revealLeaves(assembled, args.reveal);
      assembled.group.disclosure = 'selective';
    }
    const sensitivity = assembled.sensitivity as Sensitivity;

    // Authorize the act against the verified leaf: replay, ceiling, consent discharge. The Warden POLICY gate
    // (`requiresHumanAt`, default MEDIUM) forces the owner's fresh consent for a sensitive disclosure even when
    // the issuer attached no `requiresDischarge` caveat — so SEALED never discloses with no human (§3).
    const authCtx = { ...ctx, sensitivity, owner, requiresHumanAt: this.config.requiresHumanAt };
    let decision = await authorizeInvocation(inv, authCtx, leaf);

    // Consent step-up (MEDIUM+): the Warden obtains a discharge from the DESIGNATED Signet — never via the
    // Emissary — bound to this act's txn, then retries. The macaroon third-party caveat made real; this is
    // what replaces the requester-chosen approver at high sensitivity.
    if (!decision.allow && decision.needsDischarge && decision.needsDischarge.length > 0) {
      if (!this.dischargeRequester) return deny('this disclosure needs a consent discharge but no discharge channel is wired');
      const audience = leaf.caveats.audience ?? leaf.holder;
      const discharges: Discharge[] = [...(inv.discharges ?? [])];
      for (const need of decision.needsDischarge) {
        const d = await this.dischargeRequester.requestDischarge({
          txn: inv.act.txn,
          by: need.by,
          predicate: need.predicate,
          claim: args.claim,
          kind: spec.kind,
          owner,
          audience,
          sensitivity,
          reason: `Disclose “${args.claim}” — ${spec.kind}`,
        });
        if (!d) return deny('consent declined at the Signet');
        discharges.push(d);
      }
      decision = await authorizeInvocation({ ...inv, discharges }, authCtx, leaf);
    }
    if (!decision.allow) {
      // A ceiling/sensitivity denial reveals that artefacts exist above the holder's clearance — return the
      // same message as "no artefacts" so the two are indistinguishable. Structural denials stay specific.
      if (/ceiling|sensitivity/.test(decision.reason)) return deny('not authorized to disclose the requested claim');
      return deny(`invocation refused: ${decision.reason}`);
    }

    // Bind the scroll to the capability's audience (forge-for-a-recipient), else to the VERIFIED holder —
    // NEVER a requester-chosen recipient (the other half of finding A).
    const bindSubject = leaf.caveats.audience ?? leaf.holder;
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
