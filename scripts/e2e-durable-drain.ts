/**
 * e2e / regression: the transport DURABLE DRAIN (@didcid 0.6.3 ackDidComm + receiveDidComm({ack:false})).
 *
 * The loop reads NON-destructively and acks a message only once it is durably handled — so a crash between
 * read and handling loses nothing (at-least-once), while a message still being processed is never dispatched
 * twice. Proven deterministically against a STUB keymaster whose mailbox mimics the relay: receiveDidComm
 * returns un-acked entries (with ids); ackDidComm removes by id. No live node, no Ollama.
 *
 *   (1) a cleanly-handled request is ACKED (removed) and not redelivered
 *   (2) at-least-once — a handler that THROWS does not ack, so the message is REDELIVERED until it sticks
 *   (3) no double-dispatch — a message still in flight (slow handler) is NOT dispatched again on the re-poll
 *   (4) a reply resolves its waiter AND is acked (consumed, not re-dispatched as a request)
 *   (5) defer-when-not-serving — a request that arrives with no handler is LEFT on the relay, then dispatched
 *       once a handler serves (the whole point: a request before we're serving is not lost)
 *
 * Run:  npm run e2e:durable-drain
 */
import { DidCommTransport } from '@hearthold/core';
import type { KeymasterHandle, HearthholdMessage } from '@hearthold/core';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

interface Entry { id: string; message: { thid?: string; body: HearthholdMessage }; metadata: { authenticated: boolean; sender: string } }

/** A stub keymaster whose mailbox mimics the relay: receive returns un-acked entries with ids; ack removes them. */
function makeStub() {
  const mailbox = new Map<string, Entry>();
  const sent: { to: string; body: HearthholdMessage; thid?: string }[] = [];
  let receiveCalls = 0;
  const keymaster = {
    receiveDidComm: async (opts: { name?: string; ack?: boolean } = {}) => {
      receiveCalls += 1;
      const out = [...mailbox.values()];
      // The real 0.6.3 default (ack:true) would remove here; the loop always passes ack:false, so we don't.
      if (opts.ack !== false) for (const e of out) mailbox.delete(e.id);
      return out as unknown[];
    },
    ackDidComm: async (ids: string[]) => {
      let removed = 0;
      for (const id of ids) if (mailbox.delete(id)) removed += 1;
      return removed;
    },
    sendDidComm: async (msg: { type: string; thid?: string; body: HearthholdMessage }, to: string) => {
      sent.push({ to, body: msg.body, thid: msg.thid });
    },
  };
  const inject = (id: string, body: HearthholdMessage, over: Partial<Entry> = {}): void => {
    mailbox.set(id, {
      id,
      message: { body, ...(over.message ?? {}) },
      metadata: { authenticated: true, sender: 'did:cid:peer#key-1', ...(over.metadata ?? {}) },
    });
  };
  return { keymaster: keymaster as unknown as KeymasterHandle['keymaster'], mailbox, sent, inject, get receiveCalls() { return receiveCalls; } };
}

const handleOf = (stub: ReturnType<typeof makeStub>): KeymasterHandle => ({ keymaster: stub.keymaster } as unknown as KeymasterHandle);
const POLL = 15;

async function main(): Promise<void> {
  process.stdout.write('Hearthold transport durable-drain e2e (stub mailbox; no node/Ollama)\n');

  // (1) cleanly handled → acked, not redelivered ─────────────────────────────────────────────────────────
  step('(1) a cleanly-handled request is ACKED (removed) and not redelivered');
  {
    const stub = makeStub();
    const t = new DidCommTransport(handleOf(stub), 'r1', 'http://unused');
    const seen: string[] = [];
    await t.serve(async (body) => { seen.push(body.type); return { type: 'test/reply' } as HearthholdMessage; }, { pollMs: POLL });
    stub.inject('m-a', { type: 'test/req' } as HearthholdMessage);
    await sleep(120);
    check('the request was dispatched exactly once', seen.filter((s) => s === 'test/req').length === 1);
    check('a reply was sent', stub.sent.some((s) => s.body.type === 'test/reply'));
    check('the message was ACKED off the relay (mailbox empty)', !stub.mailbox.has('m-a'));
  }

  // (2) at-least-once — throw → redelivered until handled ──────────────────────────────────────────────────
  step('(2) at-least-once — a handler that THROWS is NOT acked, so the message REDELIVERS until it sticks');
  {
    const stub = makeStub();
    const t = new DidCommTransport(handleOf(stub), 'r2', 'http://unused');
    let attempts = 0;
    await t.serve(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('simulated crash mid-handle'); // fails twice, succeeds on the 3rd
      return null;
    }, { pollMs: POLL });
    stub.inject('m-b', { type: 'test/req' } as HearthholdMessage);
    await sleep(220);
    check('the message was retried after each throw (>= 3 dispatches)', attempts >= 3);
    check('once handled cleanly it was ACKED (no longer redelivering)', !stub.mailbox.has('m-b'));
  }

  // (3) no double-dispatch while in flight ────────────────────────────────────────────────────────────────
  step('(3) no double-dispatch — a slow in-flight handler is NOT re-dispatched on the re-poll');
  {
    const stub = makeStub();
    const t = new DidCommTransport(handleOf(stub), 'r3', 'http://unused');
    let dispatched = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    await t.serve(async () => { dispatched += 1; await gate; return null; }, { pollMs: POLL });
    stub.inject('m-c', { type: 'test/req' } as HearthholdMessage);
    await sleep(120); // several polls elapse while the handler is gated and the message is still un-acked
    check('dispatched exactly ONCE despite many re-polls of the un-acked message', dispatched === 1);
    check('still on the relay while in flight (not yet acked)', stub.mailbox.has('m-c'));
    release();
    await sleep(80);
    check('acked once the handler completed', !stub.mailbox.has('m-c'));
  }

  // (4) a reply resolves its waiter and is acked ──────────────────────────────────────────────────────────
  step('(4) a reply resolves its waiter AND is acked (not re-dispatched as a request)');
  {
    const stub = makeStub();
    const t = new DidCommTransport(handleOf(stub), 'r4', 'http://unused');
    // request() sends and registers a pending waiter keyed by a fresh thid; capture that thid from the send.
    const replyP = t.request('did:cid:target', { type: 'test/ask' } as HearthholdMessage, { timeoutMs: 2000, pollMs: POLL });
    await sleep(30);
    const askThid = stub.sent.find((s) => s.body.type === 'test/ask')?.thid;
    check('the request was sent with a thid', typeof askThid === 'string' && askThid.length > 0);
    stub.inject('m-r', { type: 'test/answer' } as HearthholdMessage, { message: { thid: askThid, body: { type: 'test/answer' } as HearthholdMessage } });
    const reply = (await replyP) as { type?: string };
    check('the waiter resolved with the correlated reply', reply?.type === 'test/answer');
    await sleep(40);
    check('the reply was ACKED off the relay', !stub.mailbox.has('m-r'));
  }

  // (5) defer-when-not-serving ────────────────────────────────────────────────────────────────────────────
  step('(5) defer-when-not-serving — a request with no handler is LEFT, then dispatched once serving');
  {
    const stub = makeStub();
    const t = new DidCommTransport(handleOf(stub), 'r5', 'http://unused');
    t.keepAlive(POLL); // draining, but NOT serving a handler yet
    stub.inject('m-d', { type: 'test/req' } as HearthholdMessage);
    await sleep(90);
    check('NOT dispatched and NOT acked while unserved (waits on the relay)', stub.mailbox.has('m-d'));
    const seen: string[] = [];
    await t.serve(async (body) => { seen.push(body.type); return null; }, { pollMs: POLL });
    await sleep(90);
    check('dispatched once a handler serves', seen.includes('test/req'));
    check('and then acked', !stub.mailbox.has('m-d'));
  }

  process.stdout.write(`\n${failures === 0 ? '✓ durable drain: at-least-once, no double-dispatch, defer-when-unserved' : `✗ FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-durable-drain: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
