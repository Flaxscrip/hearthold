/**
 * Transport seam.
 *
 * Hearthold's protocol messages (protocol.ts) are transport-agnostic. This module defines the
 * `Transport` interface — a request/reply abstraction — and its DIDComm v2 implementation.
 *
 * DIDComm gives us, for free, what the old HTTP path needed a handshake for:
 *   - authcrypt authenticates the sender DID at the transport layer (no challenge to prove control);
 *   - the message reaches the recipient's mailbox with no registry footprint (no relationship leak);
 *   - store-and-forward means the Witness can submit while the Warden is offline.
 *
 * Request/reply is correlated by DIDComm thread id (`thid`): a request carries a fresh `thid`, and
 * the reply echoes it.
 */

import { randomUUID } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import type { HearthholdMessage } from './protocol.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Handles an inbound request, returning a reply to send back (or null for no reply). */
export type RequestHandler = (
  message: HearthholdMessage,
  fromDid: string,
) => Promise<HearthholdMessage | null>;

export interface Transport {
  /** One-time setup — advertise this identity's endpoint so peers can reach it. */
  ready(): Promise<void>;
  /** Send a request to a peer DID and await the correlated reply. */
  request(
    toDid: string,
    message: HearthholdMessage,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<HearthholdMessage>;
  /** Start serving inbound requests. Returns a stop function. */
  serve(handler: RequestHandler, opts?: { pollMs?: number }): Promise<() => void>;
}

/** Bare DID without the key fragment that authcrypt metadata carries (`did#key-agreement-1`). */
function bareDid(sender: string | undefined): string {
  return String(sender ?? '').split('#')[0] ?? '';
}

export class DidCommTransport implements Transport {
  constructor(
    private readonly handle: KeymasterHandle,
    /** Wallet identity name this transport sends/receives as (e.g. 'hearthold-warden'). */
    private readonly idName: string,
    /** Archon node (Drawbridge) URL, used to discover the DIDComm endpoint to publish. */
    private readonly nodeUrl: string,
  ) {}

  /**
   * Publish this identity's DIDComm endpoint. We pass the endpoint explicitly (discovered from the
   * node) rather than relying on `publishDidComm(undefined)`, which silently writes key-only when
   * the keymaster points at the Drawbridge root.
   */
  async ready(): Promise<void> {
    const endpoint = await fetch(`${this.nodeUrl}/api/v1/didcomm-endpoint`)
      .then((r) => r.json())
      .then((j: unknown) => (j as { endpoint: string }).endpoint);
    if (await this.hasEndpoint(endpoint)) return; // already advertised — avoid DID-doc churn
    await this.handle.keymaster.publishDidComm(endpoint, this.idName);
  }

  /** Whether this identity already advertises the given DIDComm endpoint in its DID document. */
  private async hasEndpoint(endpoint: string): Promise<boolean> {
    try {
      const doc = (await this.handle.keymaster.resolveDID(this.idName)) as {
        didDocument?: { service?: Array<{ type?: unknown; serviceEndpoint?: unknown }> };
      };
      return (doc.didDocument?.service ?? []).some((s) => {
        const isDidComm = /DIDCommMessaging/.test(JSON.stringify(s?.type));
        const uri =
          typeof s?.serviceEndpoint === 'string'
            ? s.serviceEndpoint
            : (s?.serviceEndpoint as { uri?: string } | undefined)?.uri;
        return isDidComm && uri === endpoint;
      });
    } catch {
      return false;
    }
  }

  async request(
    toDid: string,
    message: HearthholdMessage,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<HearthholdMessage> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const pollMs = opts.pollMs ?? 1500;
    const thid = randomUUID();

    await this.handle.keymaster.sendDidComm({ type: message.type, thid, body: message }, toDid, {
      name: this.idName,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const inbound = await this.handle.keymaster.receiveDidComm({ name: this.idName });
      const reply = inbound.find((m) => (m.message as { thid?: string })?.thid === thid);
      if (reply) return (reply.message as { body: HearthholdMessage }).body;
      await sleep(pollMs);
    }
    throw new Error(`transport: timed out awaiting reply to ${message.type}`);
  }

  async serve(handler: RequestHandler, opts: { pollMs?: number } = {}): Promise<() => void> {
    const pollMs = opts.pollMs ?? 1500;
    let running = true;

    const loop = async (): Promise<void> => {
      while (running) {
        let inbound: Awaited<ReturnType<typeof this.handle.keymaster.receiveDidComm>> = [];
        try {
          inbound = await this.handle.keymaster.receiveDidComm({ name: this.idName });
        } catch {
          inbound = [];
        }

        for (const m of inbound) {
          const fromDid = bareDid(m.metadata?.sender);
          const wrapped = m.message as { thid?: string; body?: HearthholdMessage };
          const body = wrapped?.body;
          if (!fromDid || !body?.type) continue;

          let reply: HearthholdMessage | null = null;
          try {
            reply = await handler(body, fromDid);
          } catch {
            reply = null;
          }
          if (reply) {
            await this.handle.keymaster
              .sendDidComm({ type: reply.type, thid: wrapped.thid, body: reply }, fromDid, {
                name: this.idName,
              })
              .catch(() => undefined);
          }
        }

        if (running) await sleep(pollMs);
      }
    };

    void loop();
    return () => {
      running = false;
    };
  }
}
