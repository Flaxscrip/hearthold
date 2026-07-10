import {
  PROTOCOL_VERSION,
  type RequestHandler,
  type HearthholdMessage,
  type WitnessSubmission,
  type EvidenceRequest,
  type KbRequestMessage,
  type KbLoginStartMessage,
  type KbLoginCompleteMessage,
  type KbSessionRequestMessage,
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
  /** All KBs this Warden serves, keyed by kbId. A request is routed to the KB matching its `kbId`. */
  kbs?: Map<string, KbService>,
): RequestHandler {
  const deny = (reason: string): HearthholdMessage => ({
    type: 'hearthold/error',
    version: PROTOCOL_VERSION,
    reason,
  });

  // Resolve the KbService for a request's kbId (or deny if unknown / none provisioned).
  const kbFor = (kbId: string | undefined): KbService | undefined => (kbId ? kbs?.get(kbId) : undefined);

  return async (message, fromDid) => {
    switch (message.type) {
      case 'hearthold/witness-submission': {
        if (!(await delegations.isAuthorized(fromDid))) {
          return deny('no valid delegation for this Emissary');
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
        const kb = kbFor((message as { kbId?: string }).kbId);
        if (!kb) return deny('unknown KB');
        return kb.challenge();
      }
      case 'hearthold/kb-request': {
        const req = (message as KbRequestMessage).request;
        const kb = kbFor((req as { kbId?: string }).kbId);
        if (!kb) return deny('unknown KB');
        return kb.serve(req);
      }

      // KB web login (challenge/response) — keys stay in the member's wallet/Signet; the Warden
      // authenticates (issues + verifies the challenge) and issues the session. The Mage only relays.
      case 'hearthold/kb-login-start': {
        const m = message as KbLoginStartMessage;
        const kb = kbFor(m.kbId);
        if (!kb) return deny('unknown KB');
        process.stdout.write(`[kb] login-start received (kb=${m.kbId}) from ${fromDid.slice(0, 20)}…\n`);
        try {
          const challenge = await kb.startLogin(m.kbId, m.callback);
          process.stdout.write(`[kb] → challenge issued\n`);
          return { type: 'hearthold/kb-login-challenge', version: PROTOCOL_VERSION, challenge };
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          process.stdout.write(`[kb] login-start FAILED: ${reason}\n`);
          return deny(`kb login failed: ${reason}`);
        }
      }
      case 'hearthold/kb-login-complete': {
        const m = message as KbLoginCompleteMessage;
        const kb = kbFor(m.kbId);
        if (!kb) return deny('unknown KB');
        return kb.completeLogin(m.response);
      }
      case 'hearthold/kb-session-request': {
        const m = message as KbSessionRequestMessage;
        const kb = kbFor(m.kbId);
        if (!kb) return deny('unknown KB');
        return kb.serveWithSession(m);
      }

      default:
        return null;
    }
  };
}
