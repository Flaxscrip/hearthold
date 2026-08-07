/**
 * The Emissary's INVOKE path — the world-facing counterpart to `submit`.
 *
 * Where `submit` presents the Emissary's DELEGATION to add an observation, `invoke` presents its Sovereign-issued
 * SCOPE capability to request evidence: the Emissary asks the Warden for an invocation challenge, answers it with
 * the scope VC, and sends a `hearthold/invocation`. The Warden's reference monitor authorizes it (ceiling,
 * revocation, and — for sensitive claims — the owner's consent step-up) and mints a signed evidence graph the
 * Emissary can then present to a verifier. Designation is authority: the Emissary acts only within the grant.
 */

import { randomUUID } from 'node:crypto';

import {
  presentProof,
  PROTOCOL_VERSION,
  type KeymasterHandle,
  type Transport,
  type CapabilityInvocation,
  type EvidenceResponse,
  type ErrorMessage,
  type ChallengeResponseMessage,
} from '@hearthold/core';

export interface InvokeSpec {
  /** The fact to prove (the Warden derives + signs it from the owner's vault). */
  claim: string;
  /** The witness kind backing the claim (e.g. `location`) — must be within the capability's grant. */
  kind: string;
  /** The invocation target (defaults to `hearthold:vault:<kind>`), within the capability's `resources`. */
  target?: string;
  /** Optional selective-disclosure leaf indices. */
  reveal?: number[];
}

/**
 * Run one invocation against the Warden and return its reply. The caller owns the transport (a one-shot CLI
 * creates one; the control daemon reuses its mailbox). On `granted` the reply carries the minted evidence
 * graph's `credentialDid` — accept it to present it onward.
 */
export async function invokeEvidence(
  handle: KeymasterHandle,
  transport: Pick<Transport, 'request'>,
  wardenDid: string,
  spec: InvokeSpec,
): Promise<EvidenceResponse | ErrorMessage> {
  const kind = spec.kind;
  const target = spec.target ?? `hearthold:vault:${kind}`;

  // 1. A fresh, Warden-minted invocation challenge (the audience binding).
  const chReply = await transport.request(wardenDid, {
    type: 'hearthold/challenge-request',
    version: PROTOCOL_VERSION,
    purpose: 'invocation',
  });
  if (chReply.type !== 'hearthold/challenge-response') {
    const reason = chReply.type === 'hearthold/error' ? (chReply as ErrorMessage).reason : `unexpected reply ${chReply.type}`;
    return { type: 'hearthold/error', version: PROTOCOL_VERSION, reason: `could not obtain an invocation challenge: ${reason}` };
  }

  // 2. Present the scope capability by answering the challenge.
  const presentation = await presentProof(handle, (chReply as ChallengeResponseMessage).challenge);

  // 3. Invoke — the act is the object; the scope is read from the verified presentation, not the wire.
  const inv: CapabilityInvocation = {
    type: 'hearthold/invocation',
    version: PROTOCOL_VERSION,
    presentation,
    act: {
      action: 'prove',
      target,
      nonce: randomUUID(),
      txn: randomUUID(),
      args: { claim: spec.claim, spec: { kind }, ...(spec.reveal && spec.reveal.length > 0 ? { reveal: spec.reveal } : {}) },
    },
  };
  const reply = await transport.request(wardenDid, inv);
  if (reply.type === 'hearthold/evidence-response') return reply as EvidenceResponse;
  if (reply.type === 'hearthold/error') return reply as ErrorMessage;
  return { type: 'hearthold/error', version: PROTOCOL_VERSION, reason: `unexpected reply ${reply.type}` };
}
