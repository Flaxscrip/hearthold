import {
  PROTOCOL_VERSION,
  type RequestHandler,
  type HearthholdMessage,
  type WitnessSubmission,
  type EvidenceRequest,
} from '@hearthold/core';

import type { WardenService } from './service.js';
import type { DelegationStore } from './delegations.js';
import type { EvidenceService } from './evidence.js';

/**
 * Builds the Warden's inbound request handler. Authentication of `fromDid` is already done by the
 * transport (authcrypt); here we authorize and dispatch by message type.
 */
export function makeWardenHandler(
  service: WardenService,
  delegations: DelegationStore,
  evidence?: EvidenceService,
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

      default:
        return null;
    }
  };
}
