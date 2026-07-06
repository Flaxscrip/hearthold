import {
  PROTOCOL_VERSION,
  type RequestHandler,
  type HearthholdMessage,
  type WitnessSubmission,
  type EvidenceRequest,
  type KbRequestMessage,
} from '@hearthold/core';

import type { WardenService } from './service.js';
import type { DelegationStore } from './delegations.js';
import type { EvidenceService } from './evidence.js';
import type { KbService } from './kb.js';

/**
 * Builds the Warden's inbound request handler. Authentication of `fromDid` is already done by the
 * transport (authcrypt); here we authorize and dispatch by message type.
 */
export function makeWardenHandler(
  service: WardenService,
  delegations: DelegationStore,
  evidence?: EvidenceService,
  kb?: KbService,
): RequestHandler {
  const deny = (reason: string): HearthholdMessage => ({
    type: 'hearthold/error',
    version: PROTOCOL_VERSION,
    reason,
  });

  return async (message, fromDid) => {
    switch (message.type) {
      case 'hearthold/witness-submission': {
        if (!(await delegations.isAuthorized(fromDid))) {
          return deny('no valid delegation for this Witness');
        }
        return service.handleSubmission(message as WitnessSubmission, fromDid);
      }

      case 'hearthold/evidence-request': {
        if (!evidence) {
          return {
            type: 'hearthold/evidence-response',
            version: PROTOCOL_VERSION,
            status: 'denied',
            reason: 'evidence service not configured',
          };
        }
        const delegationValid = await delegations.isAuthorized(fromDid);
        return evidence.handle(message as EvidenceRequest, fromDid, delegationValid);
      }

      // Knowledge Base — the KB service authenticates + authorizes end-to-end (the requester's own
      // signature over our nonce), so a relaying Mage never gains authority. `fromDid` is only the
      // transport hop (the Mage), deliberately not trusted for identity here.
      case 'hearthold/kb-challenge-request': {
        if (!kb) return deny('KB service not configured');
        return kb.challenge();
      }
      case 'hearthold/kb-request': {
        if (!kb) return deny('KB service not configured');
        return kb.serve((message as KbRequestMessage).request);
      }

      default:
        return null;
    }
  };
}
