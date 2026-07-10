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
  /**
   * Keep the mailbox reader running continuously, even with no inflight request or serve handler. A
   * request-only client (e.g. the Mage's kb-web bridge) should call this so its reader never goes idle
   * between requests — an idle reader lets the relay session go stale, silently dropping later replies.
   */
  keepAlive?(pollMs?: number): void;
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

  // `receiveDidComm` is destructive, so there must be exactly ONE reader of the mailbox. This single
  // loop serves both roles: it resolves replies to in-flight requests (matched by `thid`) and
  // dispatches incoming requests to the handler. Handlers run WITHOUT blocking the loop, so a handler
  // that itself awaits a reply (an approver / relay) can't deadlock the sole reader.
  private readonly pending = new Map<string, (m: HearthholdMessage) => void>();
  private handler: RequestHandler | null = null;
  private loopRunning = false;
  private keepDraining = false;

  /** Keep the reader loop alive continuously (see the interface note). Idempotent. */
  keepAlive(pollMs = 1500): void {
    this.keepDraining = true;
    this.ensureLoop(pollMs);
  }

  private ensureLoop(pollMs: number): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    void (async () => {
      while (this.keepDraining || this.handler || this.pending.size > 0) {
        let inbound: Awaited<ReturnType<typeof this.handle.keymaster.receiveDidComm>> = [];
        try {
          inbound = await this.handle.keymaster.receiveDidComm({ name: this.idName });
        } catch {
          inbound = [];
        }

        for (const m of inbound) {
          const wrapped = m.message as { thid?: string; body?: HearthholdMessage };
          const body = wrapped?.body;
          const thid = wrapped?.thid;
          if (!body?.type) continue;

          // A reply to one of our in-flight requests — hand it to the waiter.
          if (thid && this.pending.has(thid)) {
            const resolve = this.pending.get(thid);
            this.pending.delete(thid);
            resolve?.(body);
            continue;
          }

          // Otherwise it's an incoming request — dispatch to the handler off the loop.
          const h = this.handler;
          const fromDid = bareDid(m.metadata?.sender);
          if (!h || !fromDid) continue;
          void (async () => {
            let reply: HearthholdMessage | null = null;
            try {
              reply = await h(body, fromDid);
            } catch {
              reply = null;
            }
            if (reply) {
              await this.handle.keymaster
                .sendDidComm({ type: reply.type, thid, body: reply }, fromDid, { name: this.idName })
                .catch(() => undefined);
            }
          })();
        }

        if (this.keepDraining || this.handler || this.pending.size > 0) await sleep(pollMs);
      }
      this.loopRunning = false;
    })();
  }

  async request(
    toDid: string,
    message: HearthholdMessage,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<HearthholdMessage> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const pollMs = opts.pollMs ?? 1500;
    const thid = randomUUID();

    const reply = new Promise<HearthholdMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(thid)) reject(new Error(`transport: timed out awaiting reply to ${message.type}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(thid, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });

    await this.handle.keymaster.sendDidComm({ type: message.type, thid, body: message }, toDid, {
      name: this.idName,
    });
    this.ensureLoop(pollMs);
    return reply;
  }

  async serve(handler: RequestHandler, opts: { pollMs?: number } = {}): Promise<() => void> {
    this.handler = handler;
    this.ensureLoop(opts.pollMs ?? 1500);
    return () => {
      this.handler = null;
    };
  }
}
