/**
 * e2e / regression: transport.request() timeout semantics + the timeout-before-attach crash guard.
 *
 * Two properties, both deterministic (no Archon node, no Ollama):
 *
 *   1. CRASH GUARD — a request whose reply never arrives must reject the CALLER cleanly and produce ZERO
 *      unhandled rejections. The original bug: the reply promise's timeout timer started at CONSTRUCTION,
 *      but the caller can only await the promise after request() RETURNS it (after `await sendDidComm`); a
 *      send outlasting `timeoutMs` rejected `reply` with nothing attached → an unhandled rejection that
 *      EXITS the process on Node ≥15 (observed live 2026-08-24: a bounded 10s login-rewrap send to a slow
 *      Signet killed the mages Warden).
 *
 *   2. FALSE-TIMEOUT GUARD (the semantic fix) — a SLOW send FOLLOWED by a TIMELY reply must NOT time out.
 *      The timer is now armed only AFTER the send resolves, so `timeoutMs` measures REPLY-WAIT, not
 *      send+reply. This case FAILS against the old construct-time timer (the timer fires mid-send) and
 *      PASSES once the timer is armed post-send.
 *
 * Run:  npm run e2e:transport-timeout
 */
import { DidCommTransport } from '@hearthold/core';
import type { KeymasterHandle, HearthholdMessage } from '@hearthold/core';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  // Count unhandled rejections instead of letting them crash. Installing this handler overrides Node's
  // default crash-on-unhandled-rejection, so the test survives and can ASSERT the count is zero.
  let unhandled = 0;
  process.on('unhandledRejection', () => {
    unhandled += 1;
  });

  // ── 1. Crash guard: a slow send, and no reply ever arrives ──────────────────────────────────────────
  {
    const stub = {
      keymaster: {
        sendDidComm: async (): Promise<void> => {
          await sleep(120);
        },
        receiveDidComm: async (): Promise<unknown[]> => [], // no reply — the reply-wait times out cleanly
      },
      registry: 'local',
    } as unknown as KeymasterHandle;

    const transport = new DidCommTransport(stub, 'test-transport-crash', 'http://unused.invalid');

    process.stdout.write('\n▸ a request whose reply never arrives rejects cleanly — no unhandled rejection\n');
    let rejected = false;
    let reason = '';
    try {
      await transport.request('did:cid:target', { type: 'test/ping' } as unknown as HearthholdMessage, { timeoutMs: 20, pollMs: 10 });
    } catch (e) {
      rejected = true;
      reason = e instanceof Error ? e.message : String(e);
    }
    await sleep(200); // give any stray unhandled rejection a couple of ticks to surface

    assert(rejected, 'the caller receives the timeout rejection (error not swallowed)');
    assert(/timed out awaiting reply/.test(reason), 'the rejection is the transport reply-wait timeout');
    assert(unhandled === 0, 'ZERO unhandled rejections — a slow send no longer exits the process');
  }

  // ── 2. False-timeout guard: a slow send FOLLOWED by a timely reply must resolve (the semantic fix) ────
  {
    // sendDidComm takes 60ms and captures the thid; receiveDidComm then delivers the correlated reply on the
    // next poll. timeoutMs = 40ms < the 60ms send: under the OLD construct-time timer this fires MID-SEND and
    // false-times-out; with the timer armed post-send, the 40ms reply-wait starts only after the send, and the
    // reply (delivered within ~1 poll) resolves it.
    let capturedThid = '';
    let delivered = false;
    const stub = {
      keymaster: {
        sendDidComm: async (msg: { thid: string }): Promise<void> => {
          capturedThid = msg.thid;
          await sleep(60);
        },
        receiveDidComm: async (): Promise<unknown[]> => {
          if (capturedThid && !delivered) {
            delivered = true;
            return [{ message: { thid: capturedThid, body: { type: 'test/pong' } } }];
          }
          return [];
        },
      },
      registry: 'local',
    } as unknown as KeymasterHandle;

    const transport = new DidCommTransport(stub, 'test-transport-timely', 'http://unused.invalid');

    process.stdout.write('\n▸ a slow send FOLLOWED by a timely reply resolves — no false timeout\n');
    const reply = (await transport.request('did:cid:target', { type: 'test/ping' } as unknown as HearthholdMessage, {
      timeoutMs: 40, // < the 60ms send: only passes because the reply-wait clock starts AFTER the send
      pollMs: 10,
    })) as { type?: string };
    await sleep(50);

    assert(reply?.type === 'test/pong', 'the reply resolves (reply-wait measured from after the send, not from construction)');
    assert(unhandled === 0, 'still ZERO unhandled rejections across both cases');
  }

  process.stdout.write('\n✓ transport timeout: fails safe (no unhandled rejection) AND reply-wait is measured post-send\n');
  process.exit(0);
}

void main();
