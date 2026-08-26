/**
 * Co-sign SENDER over DIDComm — the transport half of an agent-family escalation, in `core` so the
 * sovereign (which depends only on `core` + `control-types`, never `warden`) can escalate a control act to
 * the human parent's Signet.
 *
 * The wire contract is the SAME one the Warden already speaks (`warden/kb.ts` `makeDidcommActionApprover`):
 * a `hearthold/kb-approval-request` answered by the recipient's Signet with a `hearthold/kb-approval-response`.
 * `makeSovereignHandler` already handles that request (proof-of-human at the parent's Pin/Http gate), so the
 * parent's existing Signet answers this with no new handler. Keeping the two senders on one message contract
 * means a control-escalation and a spend/KB step-up land in the same door — a compromised sender can pick
 * neither the words shown nor whether a human is really there.
 *
 * Fail-closed: a decline, a timeout, or any throw ⇒ NOT approved (`false`). The caller treats that as a
 * refusal, never a silent pass.
 */

import { PROTOCOL_VERSION } from './protocol.js';
import type { Transport } from './transport.js';

/**
 * Ask `approverDid`'s Signet to authorize a control act, over DIDComm, and return whether it approved.
 * Mirrors the Warden's `makeDidcommActionApprover` request exactly, so the parent's `makeSovereignHandler`
 * answers it. Returns `false` on decline, unreachable Signet, timeout, or any error (fail-closed).
 */
export async function requestActionApprovalOverDidComm(
  transport: Transport,
  approverDid: string,
  req: { action: string; resource: string; summary: string },
  timeoutMs = 170_000,
): Promise<boolean> {
  try {
    const reply = await transport.request(
      approverDid,
      {
        type: 'hearthold/kb-approval-request',
        version: PROTOCOL_VERSION,
        member: approverDid,
        action: req.action,
        resource: req.resource,
        summary: req.summary,
      },
      { timeoutMs },
    );
    return reply.type === 'hearthold/kb-approval-response' && (reply as { approved?: boolean }).approved === true;
  } catch {
    return false; // unreachable Signet / timeout / error ⇒ not approved (fail closed)
  }
}
