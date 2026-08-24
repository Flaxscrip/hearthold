/**
 * CGPR ticket authentication — the ticket is broker B's vouch for C, the design's root of authority
 * (A2A-BRIEF §constraints; docs/a2a-cgpr.md). B SIGNS the ticket; the gateway VERIFIES the signature and
 * checks B is a trusted CGPR broker (a static allowlist or a trust registry). This closes the "unsigned
 * ticket / self-asserted requester" gap WITHOUT touching the A2A envelope: the ticket already rides inside
 * the A2A request artifact; we add a proof and verify it. It reuses the same trust primitives as evidence
 * verification (`keymaster.verifyProof` + `TrustEvaluator`).
 */

import type { KeymasterHandle, TrustEvaluator } from '@hearthold/core';
import type { CgprTicket } from '@hearthold/cgpr-types';

/**
 * Broker B signs a ticket (detached proof over the whole ticket object). This is B's side — out of scope in
 * the design (a mock broker stands in for tests); it lives here so the sign/verify pair stay together.
 */
export async function signTicket(broker: KeymasterHandle, brokerName: string, ticket: CgprTicket): Promise<CgprTicket> {
  await broker.keymaster.setCurrentId(brokerName);
  return (await broker.keymaster.addProof(ticket, brokerName)) as CgprTicket;
}

/** A gateway-injected ticket verifier: proves B signed the ticket and that B is a trusted CGPR broker. */
export type TicketVerifier = (ticket: CgprTicket) => Promise<{ ok: true; broker: string } | { ok: false; reason: string }>;

/**
 * Build a ticket verifier. The gateway holds no keys — the deployment injects this, made with a resolution
 * keymaster and B's trust source: a static `trustedBrokers` allowlist and/or a `brokerRegistry` (TRQP /
 * GroupTrustRegistry) that authorizes B to issue CGPR tickets. Fail-closed on any gap.
 */
export function makeTicketVerifier(opts: {
  keymaster: KeymasterHandle;
  trustedBrokers?: string[];
  brokerRegistry?: TrustEvaluator;
  /** The resource the registry authorizes B against (default 'cgpr-ticket'). */
  ticketResource?: string;
}): TicketVerifier {
  const verifyProof = opts.keymaster.keymaster.verifyProof.bind(opts.keymaster.keymaster) as (o: unknown) => Promise<boolean>;
  return async (ticket) => {
    const proof = (ticket as { proof?: { verificationMethod?: string } }).proof;
    if (!proof) return { ok: false, reason: 'ticket is unsigned (no broker vouch)' };
    if (!(await verifyProof(ticket).catch(() => false))) return { ok: false, reason: 'ticket signature does not verify' };
    const broker = (proof.verificationMethod ?? '').split('#')[0] ?? '';
    if (!broker) return { ok: false, reason: 'ticket signer unknown' };
    const trustedStatic = opts.trustedBrokers?.includes(broker) ?? false;
    const trustedRegistry = opts.brokerRegistry
      ? (await opts.brokerRegistry
          .authorize({ entity_id: broker, action: 'issue', resource: opts.ticketResource ?? 'cgpr-ticket' })
          .catch(() => ({ authorized: false }))).authorized
      : false;
    if (!trustedStatic && !trustedRegistry) return { ok: false, reason: `broker ${broker.slice(0, 24)}… is not a trusted CGPR broker` };
    return { ok: true, broker };
  };
}
