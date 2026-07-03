import {
  PROTOCOL_VERSION,
  presentProof,
  signEvidenceApproval,
  type RequestHandler,
  type ProofRequestMessage,
  type ApprovalRequestMessage,
  type EvidenceApprovalStatement,
  type KeymasterHandle,
} from '@hearthold/core';

import type { ApprovalGate } from './signet.js';

/**
 * The Sovereign's inbound handler. Two disclosures, both gated by the Signet's `ApprovalGate` (a
 * fresh proof-of-human), never automatic:
 *
 *  - `proof-request` (from a verifier or the Witness projector): present a held credential.
 *  - `approval-request` (from the **Warden**, on the direct control-plane channel): co-sign a
 *    sensitive evidence disclosure. The Warden authored the description; the Signet shows the
 *    Sovereign the Warden's words (never the requesting agent's), and on approval the Sovereign
 *    issues a HearthholdApproval back to the Warden.
 */
export function makeSovereignHandler(sovereign: KeymasterHandle, gate: ApprovalGate): RequestHandler {
  return async (message, fromDid) => {
    if (message.type === 'hearthold/proof-request') {
      const req = message as ProofRequestMessage;
      const challengeDid = req.challengeDid;
      const humanProof = await gate.approve({ requester: fromDid, challengeDid, schema: req.schema });
      if (!humanProof) {
        return { type: 'hearthold/error', version: PROTOCOL_VERSION, reason: 'disclosure declined by the Sovereign' };
      }
      const responseDid = await presentProof(sovereign, challengeDid);
      return { type: 'hearthold/proof-presentation', version: PROTOCOL_VERSION, responseDid, humanProof };
    }

    if (message.type === 'hearthold/approval-request') {
      const m = message as ApprovalRequestMessage;
      const humanProof = await gate.approve({
        requester: fromDid,
        disclosure: {
          claim: m.claim,
          evidenceRoot: m.evidenceRoot,
          requiredLevel: m.requiredLevel,
          reason: m.reason,
        },
      });
      if (!humanProof) {
        return { type: 'hearthold/approval-response', version: PROTOCOL_VERSION, approved: false, reason: 'declined by the Sovereign' };
      }
      if (humanProof.level < m.requiredLevel) {
        return {
          type: 'hearthold/approval-response',
          version: PROTOCOL_VERSION,
          approved: false,
          reason: `proof-of-human level ${humanProof.level} below required ${m.requiredLevel}`,
        };
      }
      const statement: EvidenceApprovalStatement = {
        approver: m.subjectDid,
        txn: m.txn,
        claim: m.claim,
        evidenceRoot: m.evidenceRoot,
        humanProof: { method: humanProof.method, level: humanProof.level, timestamp: humanProof.timestamp },
      };
      const approval = await signEvidenceApproval(sovereign, statement);
      return { type: 'hearthold/approval-response', version: PROTOCOL_VERSION, approved: true, approval };
    }

    return null;
  };
}
