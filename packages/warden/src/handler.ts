import {
  PROTOCOL_VERSION,
  type RequestHandler,
  type HearthholdMessage,
  type WitnessSubmission,
} from '@hearthold/core';

import type { WardenService } from './service.js';
import type { DelegationStore } from './delegations.js';

/**
 * Builds the Warden's inbound request handler. Authentication of `fromDid` is already done by the
 * transport (authcrypt); here we authorize and dispatch by message type.
 */
export function makeWardenHandler(
  service: WardenService,
  delegations: DelegationStore,
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
        return {
          type: 'hearthold/evidence-response',
          version: PROTOCOL_VERSION,
          status: 'denied',
          reason: 'evidence + step-up flow is the next milestone',
        };
      }

      default:
        return null;
    }
  };
}
