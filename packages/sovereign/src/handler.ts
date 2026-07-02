import {
  PROTOCOL_VERSION,
  presentProof,
  type RequestHandler,
  type ProofRequestMessage,
  type KeymasterHandle,
} from '@hearthold/core';

import type { ApprovalGate } from './signet.js';

/**
 * The Sovereign's inbound handler: present a proof in response to a verifier's challenge — but only
 * after the Signet's `ApprovalGate` confirms a fresh human approval (proof-of-human). Presenting is
 * the external disclosure, so it is never automatic.
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
    return null;
  };
}
