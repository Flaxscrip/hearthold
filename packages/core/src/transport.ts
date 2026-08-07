/**
 * Transport seam.
 *
 * Hearthold's protocol messages (protocol.ts) are transport-agnostic. This module defines the
 * `Transport` interface — a request/reply abstraction — and its DIDComm v2 implementation.
 *
 * DIDComm gives us, for free, what the old HTTP path needed a handshake for:
 *   - authcrypt authenticates the sender DID at the transport layer (no challenge to prove control);
 *   - the message reaches the recipient's mailbox with no registry footprint (no relationship leak);
 *   - store-and-forward means the Emissary can submit while the Warden is offline.
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
   * Ensure this identity advertises the DESIRED DIDComm endpoint — publishing if absent AND **reconciling**
   * if a different (stale) endpoint is already advertised. Idempotent and quiet when already correct; when it
   * changes the DID document it logs the transition to stdout. Reconcile matters because an operator can
   * re-home a member onto a new reachable address after first boot (a Tor onion, a tailnet host, a migrated
   * node) by setting `HEARTHOLD_DIDCOMM_ENDPOINT` — before this, `ready()` published-if-absent and a stale
   * endpoint stuck forever. Throws (with a clear reason) if the write can't go through — see `publishTo`.
   */
  async ready(): Promise<void> {
    const endpoint = await this.desiredEndpoint();
    const current = await this.currentEndpoint();
    if (current === endpoint) return; // already correct — avoid DID-doc churn
    await this.publishTo(endpoint, current);
  }

  /**
   * Force-(re)publish this identity's DIDComm endpoint, even if it already matches — the explicit operator
   * path behind `<agent> republish`. `endpoint` overrides the resolved default (env → node). Clears any
   * differing endpoint first, then publishes. Returns what was set and what it replaced.
   */
  async republish(endpoint?: string): Promise<{ endpoint: string; previous?: string }> {
    const target = endpoint ?? (await this.desiredEndpoint());
    const previous = await this.currentEndpoint();
    await this.publishTo(target, previous, true);
    return { endpoint: target, previous };
  }

  /**
   * The DIDComm endpoint OTHERS deliver to (written into this identity's DID document). Normally the node's
   * own advertised endpoint (`/api/v1/didcomm-endpoint`). `HEARTHOLD_DIDCOMM_ENDPOINT` overrides it for
   * topologies where the node advertises an address the agents can't reach — an offline sandbox advertising
   * its EXTERNAL host while agents reach it in-network, or a sealed node reachable only via a Tor onion
   * mailbox. Delivery resolves the recipient's published endpoint, so it must be reachable from where
   * senders actually run.
   */
  private desiredEndpoint(): Promise<string> {
    const fromNode = (): Promise<string> =>
      fetch(`${this.nodeUrl}/api/v1/didcomm-endpoint`)
        .then((r) => r.json())
        .then((j: unknown) => (j as { endpoint: string }).endpoint);
    const override = process.env.HEARTHOLD_DIDCOMM_ENDPOINT;
    return override ? Promise.resolve(override) : fromNode();
  }

  /** The DIDComm endpoint this identity currently advertises in its DID document, or undefined. */
  private async currentEndpoint(): Promise<string | undefined> {
    try {
      const doc = (await this.handle.keymaster.resolveDID(this.idName)) as {
        didDocument?: { service?: Array<{ type?: unknown; serviceEndpoint?: unknown }> };
      };
      for (const s of doc.didDocument?.service ?? []) {
        const isDidComm = /DIDCommMessaging/.test(JSON.stringify(s?.type));
        const uri =
          typeof s?.serviceEndpoint === 'string'
            ? s.serviceEndpoint
            : (s?.serviceEndpoint as { uri?: string } | undefined)?.uri;
        if (isDidComm && typeof uri === 'string' && uri) return uri;
      }
    } catch {
      /* unresolved / no doc yet */
    }
    return undefined;
  }

  /**
   * Write the endpoint into the DID document AND apply it. Clears a DIFFERING prior endpoint first
   * (publishDidComm may add rather than replace, which would leave a stale service entry a sender could
   * pick), publishes, then drains the gatekeeper event queue with `processEvents` — because on `hyperswarm`
   * a DID update QUEUES: the endpoint's service AND its **keyAgreement key** don't become resolvable until
   * the queue is processed, so a sender can't authcrypt (this blocks both onion-endpoint advertising and
   * credential accept between nodes). On `local` a write applies immediately, so `processEvents` is a cheap
   * no-op — we run it unconditionally rather than sniff the registry. Publishing a DID is a WRITE, so it
   * fails when `nodeUrl` points at a resolve-only front (a mailbox / sealed Drawbridge that doesn't proxy
   * gatekeeper writes or inject an admin key) — the commonest cause, called out in the error so an operator
   * isn't left guessing. Logs the applied transition to stdout on success.
   */
  private async publishTo(endpoint: string, previous: string | undefined, force = false): Promise<void> {
    const changing = !!previous && previous !== endpoint;
    try {
      if (changing) await this.handle.keymaster.unpublishDidComm(this.idName);
      const ok = await this.handle.keymaster.publishDidComm(endpoint, this.idName);
      if (!ok) throw new Error('publishDidComm returned false (no current identity, or the write was rejected)');
      // On a QUEUING registry (hyperswarm / chain) the write lands only after processEvents — until then the
      // keyAgreement key + DIDComm service aren't resolvable, so a sender can't authcrypt. On `local` writes
      // apply immediately AND the resolve-only Drawbridge front doesn't expose the events route, so we skip.
      const applied = this.handle.registry !== 'local';
      if (applied) await this.handle.gatekeeper.processEvents();
      process.stdout.write(
        `[didcomm] ${this.idName}: ${changing ? `${previous} → ` : force ? 're' : ''}published ${endpoint}${applied ? ' (applied)' : ''}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[didcomm] ${this.idName}: failed to publish ${endpoint} — ${reason}. Publishing a DID endpoint is a ` +
          `WRITE: HEARTHOLD_NODE_URL (${this.nodeUrl}) must reach a gatekeeper write path (an admin-keyed ` +
          `Drawbridge / table-gateway), not a resolve-only mailbox front.`,
      );
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
        } catch (err) {
          // DO NOT swallow: a fetched message that fails to unpack (can't authdecrypt, or can't verify/resolve
          // the sender) is consumed from the mailbox but never dispatched — a silent drop that looks like a
          // hang to the sender. Name the cause so it's diagnosable (Aegis's ask), then keep the loop alive.
          process.stderr.write(
            `[didcomm] ${this.idName}: receiveDidComm/unpack FAILED — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
          );
          inbound = [];
        }

        for (const m of inbound) {
          const wrapped = m.message as { thid?: string; body?: HearthholdMessage };
          const body = wrapped?.body;
          const thid = wrapped?.thid;
          if (!body?.type) {
            process.stderr.write(`[didcomm] ${this.idName}: dropped a fetched message with no usable body (unpacked but empty) — investigate the sender's pack\n`);
            continue;
          }

          // A reply to one of our in-flight requests — hand it to the waiter.
          if (thid && this.pending.has(thid)) {
            const resolve = this.pending.get(thid);
            this.pending.delete(thid);
            resolve?.(body);
            continue;
          }

          // Otherwise it's an incoming request — dispatch to the handler off the loop.
          const h = this.handler;
          // Trust the sender ONLY on an authcrypt-AUTHENTICATED envelope — read Keymaster's own
          // `metadata.authenticated` flag rather than inferring identity from a `sender` field on a
          // non-authenticated (anoncrypt) message. The holder binding the invocation/submission path rests on
          // is this `fromDid`.
          const authenticated = m.metadata?.authenticated === true;
          const fromDid = authenticated ? bareDid(m.metadata?.sender) : '';
          if (!h || !fromDid) {
            // A body with no resolvable AUTHENTICATED sender = the authcrypt sender couldn't be
            // verified/resolved — the likely cause of a silent submit drop. Surface it (but stay quiet when
            // we simply aren't serving).
            if (h && !authenticated && m.metadata?.sender) {
              process.stderr.write(`[didcomm] ${this.idName}: dropped '${body.type}' — envelope not authcrypt-authenticated (sender not trusted)\n`);
            } else if (h && !fromDid) {
              process.stderr.write(`[didcomm] ${this.idName}: dropped '${body.type}' — no verified sender (authcrypt sender unresolved)\n`);
            }
            continue;
          }
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
