/**
 * The production `CgprBackend`: relay to the Warden over DIDComm.
 *
 * The gateway holds no secrets — it translates the inbound A2A request into the neutral internal shape
 * and relays it to the Warden's `hearthold/cgpr-request` handler over DIDComm v2 (authcrypt
 * authenticates the gateway's DID at the transport layer). The Warden runs `CgprService` and replies
 * with the neutral result; the gateway shapes `CgprGrant`/`CgprDecision` at the edge. This is the same
 * seam the in-process backend fills in tests/demo — swap one for the other with no edge changes.
 */

import { PROTOCOL_VERSION, type Transport } from '@hearthold/core';

import type { CgprBackend } from './backend.js';

export function didCommCgprBackend(
  transport: Transport,
  wardenDid: string,
  opts: { timeoutMs?: number } = {},
): CgprBackend {
  return {
    submit: async (req) => {
      const reply = await transport.request(
        wardenDid,
        {
          type: 'hearthold/cgpr-request',
          version: PROTOCOL_VERSION,
          audience: req.audience,
          scopes: req.scopes,
          purpose: req.purpose,
          validForMinutes: req.validForMinutes,
        },
        // Long enough to outlast a factor-2 step-up (the Warden may await the Sovereign's Signet).
        { timeoutMs: opts.timeoutMs ?? 200_000 },
      );
      if (reply.type === 'hearthold/cgpr-response') {
        return reply.status === 'granted'
          ? { status: 'granted', credential: reply.credential, schemaDid: reply.schemaDid, validUntil: reply.validUntil }
          : { status: 'denied', reason: reply.reason };
      }
      if (reply.type === 'hearthold/error') return { status: 'denied', reason: reply.reason };
      return { status: 'denied', reason: `unexpected reply from the Warden: ${reply.type}` };
    },
  };
}
