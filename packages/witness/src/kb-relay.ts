/**
 * The public Mage's KB relay.
 *
 * The Knowledge Portal's world-facing surface: a Witness (Mage) that carries an authorized Sovereign's
 * KB traffic to the private Warden and carries the reply back. It **forwards** `kb-challenge-request`
 * and `kb-request` to the Warden and returns the Warden's `kb-challenge` / `kb-result` — it does not
 * authenticate, authorize, or read anything. It holds no secret; the Warden decides (§7.7).
 *
 * Authentication is end-to-end: the Sovereign signs the request over the Warden's nonce, so this
 * relay cannot forge who is asking even though it sits in the middle.
 */

import { PROTOCOL_VERSION, type RequestHandler, type Transport, type HearthholdMessage } from '@hearthold/core';

const KB_TYPES = new Set(['hearthold/kb-challenge-request', 'hearthold/kb-request']);

export function makeKbRelayHandler(transport: Transport, wardenDid: string): RequestHandler {
  return async (message) => {
    if (!KB_TYPES.has(message.type)) return null;
    try {
      return await transport.request(wardenDid, message, { timeoutMs: 120_000 });
    } catch (err) {
      const reason = `KB portal could not reach the Warden: ${err instanceof Error ? err.message : String(err)}`;
      return { type: 'hearthold/kb-error', version: PROTOCOL_VERSION, reason } as HearthholdMessage;
    }
  };
}
