import {
  PROTOCOL_VERSION,
  type RequestHandler,
  type Transport,
} from '@hearthold/core';

/**
 * The Witness as projector (PVM *Mage*): the world-facing emissary.
 *
 * When a verifier asks for a proof, the Witness holds no deciding secret and never approves a
 * disclosure itself — it **relays** the request to the Sovereign's Signet, which approves with a
 * proof-of-human assertion and presents, and the Witness carries the resulting presentation back to
 * the verifier. This keeps the Signet an *occasional* approver (not an always-on server) and matches
 * draft-rosomakho-oauth-txn-challenge §7.7: the relaying agent carries the proof, it does not author
 * or approve it.
 *
 * Because `Transport.serve` awaits this handler, the inner `request` is the sole reader of the
 * Witness mailbox while a relay is in flight — request/reply correlates cleanly by `thid` (the
 * verifier↔Witness leg and the Witness↔Sovereign leg use independent thread ids).
 */
export function makeWitnessProjectorHandler(transport: Transport, sovereignDid: string): RequestHandler {
  return async (message) => {
    if (message.type === 'hearthold/proof-request') {
      try {
        // Carry the verifier's request to the Sovereign and return whatever the Signet decides:
        // a proof-presentation when approved, or an error when declined. The Witness only carries.
        return await transport.request(sovereignDid, message, { timeoutMs: 120_000 });
      } catch (err) {
        return {
          type: 'hearthold/error',
          version: PROTOCOL_VERSION,
          reason: `Witness could not reach the Sovereign: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return null;
  };
}
