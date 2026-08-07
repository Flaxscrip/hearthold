import {
  PROTOCOL_VERSION,
  type RequestHandler,
  type HearthholdMessage,
  type WitnessSubmission,
  type SubmissionReceipt,
  type CapabilityInvocation,
  type KbRequestMessage,
  type KbLoginStartMessage,
  type KbLoginCompleteMessage,
  type KbSessionRequestMessage,
  type Sensitivity,
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
  /** Owner attributed to a submission when its Emissary isn't bound to a member (single-Sovereign fallback). */
  defaultOwner?: string,
  /**
   * Ingestion policy for inbound submissions. `confirmAtOrBelow` is the quarantine floor (default SEALED =
   * quarantine everything); `isAutofileTrusted(emissaryDid)` checks the autofile trust registry so a trusted
   * device bypasses the floor. Omitted ⇒ the safe default (quarantine all, nobody autofiles).
   */
  ingest?: { confirmAtOrBelow?: Sensitivity; isAutofileTrusted: (emissaryDid: string) => Promise<boolean> },
  /**
   * Fired AFTER a submission finishes processing in the background (caption/classify/store/index) — the seam
   * for the control plane to emit the `submission-stored` SSE with the real, post-classification receipt.
   * The submit is ack'd immediately ("received & queued"); this runs later, when the artefact actually lands.
   */
  onStored?: (receipt: SubmissionReceipt, submission: WitnessSubmission, fromDid: string) => void,
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
        // Authorize by the PRESENTED delegation credential (verifyProof → kinds + member + proven holder +
        // issuer-trust in one step). Kind-enforcement (compartmentalized Emissaries) stays: a submission whose
        // kind isn't granted is refused, fail-closed.
        const kind = (message as WitnessSubmission).kind;
        const delegationProof = (message as WitnessSubmission).delegationProof;
        if (!delegationProof) return deny('submission carries no delegation presentation — present your delegation credential');
        const del = await delegations.verifyDelegationPresentation(delegationProof, fromDid);
        if (!del.ok) return deny(`delegation not proven: ${del.reason}`);
        const grantedKinds = del.kinds;
        const owner = del.member ?? defaultOwner;
        if (!grantedKinds.includes(kind)) {
          return deny(`this Emissary is not delegated for '${kind}' (granted: ${grantedKinds.join(', ') || 'none'})`);
        }
        // Ingestion gate: is THIS Emissary autofile-trusted (bypasses quarantine), and what's the floor?
        // Default (no policy) → quarantine everything (an Emissary may PROPOSE, only the Sovereign ADMITS).
        const autofileTrusted = ingest ? await ingest.isAutofileTrusted(fromDid) : false;
        const submission = message as WitnessSubmission;
        // ACK FIRST, process after: the caption (vision model) + classify can exceed the reply-wait on modest
        // hardware, giving a false "timeout" for a submission that actually succeeded. A submission is a
        // PROPOSAL, so the honest immediate reply is "received & queued" (with the deterministic artefactId);
        // the slow caption/classify/store runs in the background and fires `onStored` (→ the SSE) when the
        // artefact lands born-obsidian for the Sovereign to admit.
        void service
          .handleSubmission(submission, fromDid, owner, {
            autofileTrusted,
            ...(ingest?.confirmAtOrBelow !== undefined ? { confirmAtOrBelow: ingest.confirmAtOrBelow } : {}),
          })
          .then((receipt) => onStored?.(receipt, submission, fromDid))
          .catch((err: unknown) => process.stderr.write(`[warden] background submission processing failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`));
        return {
          type: 'hearthold/submission-receipt',
          version: PROTOCOL_VERSION,
          artefactId: service.artefactIdFor(submission),
          storedAt: new Date().toISOString(),
          queued: true,
        };
      }

      // The capability path: evidence is disclosed only by INVOKING a capability, verified at the point of use
      // (the finding-A cure). There is no legacy requester-supplied-subjectDid `evidence-request` door.
      case 'hearthold/invocation': {
        if (!evidence) {
          return { type: 'hearthold/evidence-response', version: PROTOCOL_VERSION, status: 'denied', reason: 'evidence service not configured' };
        }
        return evidence.handleInvocation(message as CapabilityInvocation, fromDid);
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
