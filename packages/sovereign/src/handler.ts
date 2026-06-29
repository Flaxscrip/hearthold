import {
  PROTOCOL_VERSION,
  presentProof,
  type RequestHandler,
  type ProofRequestMessage,
  type KeymasterHandle,
} from '@hearthold/core';

/**
 * The Sovereign's inbound handler: present a proof in response to a verifier's challenge.
 *
 * NOTE: for now this presents automatically. Presenting *is* the external-disclosure approval, so
 * the production Signet will gate it behind a human approval + proof-of-human before responding;
 * that prompt is the next milestone.
 */
export function makeSovereignHandler(sovereign: KeymasterHandle): RequestHandler {
  return async (message) => {
    if (message.type === 'hearthold/proof-request') {
      const responseDid = await presentProof(sovereign, (message as ProofRequestMessage).challengeDid);
      return { type: 'hearthold/proof-presentation', version: PROTOCOL_VERSION, responseDid };
    }
    return null;
  };
}
