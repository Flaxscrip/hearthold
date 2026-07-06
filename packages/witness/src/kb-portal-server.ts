/**
 * The public Mage's Knowledge Portal — HTTP → DIDComm bridge.
 *
 * The browser front-end can't (and shouldn't) speak DIDComm; the member's browser only needs Keymaster
 * to *sign* a KB request (`addProof`). This server is the public web face of the Mage: it accepts the
 * signed request over HTTP and relays it to the private Warden over DIDComm, returning the result.
 *
 * It authenticates and authorizes NOTHING — the Warden does that end-to-end from the member's own
 * signature (the Mage cannot forge it). The Mage carries; the Warden decides (§7.7). The signed
 * `KbRequestStatement` the browser produces is byte-for-byte the one the `sovereign kb-*` CLI produces,
 * so the Warden's `KbService` verifies it unchanged.
 */

import {
  startControlServer,
  PROTOCOL_VERSION,
  type ControlServer,
  type Transport,
  type SignedKbRequest,
} from '@hearthold/core';

export interface KbPortalOptions {
  transport: Transport;
  wardenDid: string;
  port: number;
  /** Bind host. Default loopback; set to 0.0.0.0 / a tailnet address to expose the portal publicly. */
  host?: string;
}

export function startKbPortalServer(opts: KbPortalOptions): ControlServer {
  const { transport, wardenDid } = opts;

  return startControlServer({
    port: opts.port,
    host: opts.host,
    routes: {
      // Browser asks for a fresh nonce to sign (relayed to the Warden).
      'POST /api/kb/challenge': async ({ body }) => {
        const { kbId } = (body ?? {}) as { kbId?: string };
        if (!kbId) throw new Error('kbId is required');
        const reply = await transport.request(
          wardenDid,
          { type: 'hearthold/kb-challenge-request', version: PROTOCOL_VERSION, kbId },
          { timeoutMs: 60_000 },
        );
        if (reply.type !== 'hearthold/kb-challenge') {
          throw new Error(`no challenge from the Warden (${reply.type})`);
        }
        return { nonce: reply.nonce };
      },

      // Browser submits its signed query/update; we relay it and return the Warden's result verbatim.
      'POST /api/kb/request': async ({ body }) => {
        const { request } = (body ?? {}) as { request?: SignedKbRequest };
        if (!request || !request.proof) throw new Error('a signed request is required');
        const reply = await transport.request(
          wardenDid,
          { type: 'hearthold/kb-request', version: PROTOCOL_VERSION, request },
          { timeoutMs: 120_000 },
        );
        return { result: reply };
      },
    },
    onListening: (p) =>
      process.stdout.write(
        `KB Portal (public Mage web face) on http://${opts.host ?? '127.0.0.1'}:${p}\n` +
          `  relaying to Warden: ${wardenDid.slice(0, 28)}…\n` +
          `  API: POST /api/kb/challenge · POST /api/kb/request  (browser signs; the Mage only carries)\n`,
      ),
  });
}
