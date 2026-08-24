/**
 * e2e / regression: transport.request() must NEVER crash the process when a request times out BEFORE the
 * caller attaches a handler.
 *
 * The reply promise's timeout timer starts at construction, but the caller can only await the promise
 * after request() RETURNS it — which is after `await sendDidComm`. If the send outlasts `timeoutMs`, the
 * reply rejects with nothing attached → an unhandled rejection that EXITS the process on Node ≥15.
 * Observed live (2026-08-24): a bounded 10s login-rewrap send to a slow Signet killed the mages Warden.
 * The fix attaches a no-op catch at creation. This proves the crash is gone AND that the real consumer
 * still observes the rejection (the error is not swallowed).
 *
 * Pure — no Archon node, no Ollama, deterministic.  Run:  npm run e2e:transport-timeout
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

  // A keymaster whose sendDidComm is SLOWER than the request timeout — the exact race trigger. receiveDidComm
  // returns nothing, so the poll loop idles and exits once the pending request is cleared by the timeout.
  const stub = {
    keymaster: {
      sendDidComm: async (): Promise<void> => {
        await sleep(120);
      },
      receiveDidComm: async (): Promise<unknown[]> => [],
    },
    registry: 'local',
  } as unknown as KeymasterHandle;

  const transport = new DidCommTransport(stub, 'test-transport', 'http://unused.invalid');

  process.stdout.write('\n▸ request() times out DURING a slow send (timeout 20ms < send 120ms)\n');
  let rejected = false;
  let reason = '';
  try {
    await transport.request('did:cid:target', { type: 'test/ping' } as unknown as HearthholdMessage, { timeoutMs: 20, pollMs: 10 });
  } catch (e) {
    rejected = true;
    reason = e instanceof Error ? e.message : String(e);
  }
  // Give any stray unhandled rejection a couple of event-loop ticks to surface.
  await sleep(250);

  assert(rejected, 'the caller still receives the timeout rejection (error not swallowed)');
  assert(/timed out awaiting reply/.test(reason), 'the rejection is the transport timeout');
  assert(unhandled === 0, 'ZERO unhandled rejections — request() no longer exits the process on a slow send');

  process.stdout.write('\n✓ transport timeout race: fails safe, no unhandled rejection\n');
  process.exit(0);
}

void main();
