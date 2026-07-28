/**
 * e2e: DIDComm ENDPOINT (RE)PUBLISH — the Aegis onion-mailbox ask (HEARTHOLD-ASK-republish-endpoint).
 * Proves an identity can be re-homed onto a new reachable DIDComm endpoint AFTER first boot:
 *
 *   - `ready()` publishes when absent, and now RECONCILES — a changed HEARTHOLD_DIDCOMM_ENDPOINT is applied,
 *     not ignored (the old publish-if-absent left a stale endpoint stuck forever).
 *   - `republish(endpoint?)` force-(re)publishes and reports what it replaced.
 *   - a differing prior endpoint is CLEARED first (no stale/duplicate service entry a sender could pick).
 *
 *   HEARTHOLD_PASSPHRASE=… node --experimental-strip-types scripts/e2e-republish-endpoint.ts   (live node)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, openKeymaster, ensureIdentity, DidCommTransport, IDENTITY_NAME } from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

// Read back the DIDComm endpoint an identity currently advertises (independent of the transport internals).
async function advertised(handle: Awaited<ReturnType<typeof openKeymaster>>, name: string): Promise<string | undefined> {
  const doc = (await handle.keymaster.resolveDID(name)) as {
    didDocument?: { service?: Array<{ type?: unknown; serviceEndpoint?: unknown }> };
  };
  for (const s of doc.didDocument?.service ?? []) {
    if (/DIDCommMessaging/.test(JSON.stringify(s?.type))) {
      const uri = typeof s?.serviceEndpoint === 'string' ? s.serviceEndpoint : (s?.serviceEndpoint as { uri?: string })?.uri;
      if (typeof uri === 'string' && uri) return uri;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hearthold-republish-'));
  const A = 'http://endpoint-a.local:4222/didcomm';
  const B = 'http://endpoint-b.local:4222/didcomm';
  const C = 'http://xyzonion0000000000000000000000000000000000000000000.onion:4222/didcomm';
  const savedEnv = process.env.HEARTHOLD_DIDCOMM_ENDPOINT;
  try {
    const config = { ...loadConfig(), dataRoot } as ReturnType<typeof loadConfig>;
    const handle = await openKeymaster('warden', config, process.env.HEARTHOLD_PASSPHRASE ?? 'dev');
    await ensureIdentity(handle, config);
    const tx = new DidCommTransport(handle, IDENTITY_NAME.warden, config.nodeUrl);

    step('ready() publishes the desired endpoint when none is advertised');
    process.env.HEARTHOLD_DIDCOMM_ENDPOINT = A;
    await tx.ready();
    check('endpoint A is now advertised', (await advertised(handle, IDENTITY_NAME.warden)) === A);

    step('ready() is idempotent — no churn when already correct');
    await tx.ready(); // desired still A → early return, no change
    check('endpoint A still advertised after a second ready()', (await advertised(handle, IDENTITY_NAME.warden)) === A);

    step('ready() RECONCILES — a changed HEARTHOLD_DIDCOMM_ENDPOINT re-homes the identity (was the bug)');
    process.env.HEARTHOLD_DIDCOMM_ENDPOINT = B;
    await tx.ready();
    const nowB = await advertised(handle, IDENTITY_NAME.warden);
    check('endpoint reconciled A → B', nowB === B);
    check('the stale endpoint A is no longer advertised', nowB !== A);

    step('republish(endpoint) force-(re)publishes and reports what it replaced (the onion re-home)');
    const res = await tx.republish(C);
    check('republish returns the new endpoint + the previous', res.endpoint === C && res.previous === B);
    check('endpoint C (onion) is now the advertised endpoint', (await advertised(handle, IDENTITY_NAME.warden)) === C);

    step('exactly ONE DIDComm service entry remains (no stale/duplicate a sender could pick)');
    const doc = (await handle.keymaster.resolveDID(IDENTITY_NAME.warden)) as {
      didDocument?: { service?: Array<{ type?: unknown }> };
    };
    const didcommServices = (doc.didDocument?.service ?? []).filter((s) => /DIDCommMessaging/.test(JSON.stringify(s?.type)));
    check('single DIDComm service in the DID document', didcommServices.length === 1);
  } finally {
    if (savedEnv === undefined) delete process.env.HEARTHOLD_DIDCOMM_ENDPOINT;
    else process.env.HEARTHOLD_DIDCOMM_ENDPOINT = savedEnv;
    rmSync(dataRoot, { recursive: true, force: true });
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ republish: ready() reconciles a changed endpoint + republish() re-homes onto a new address (onion)\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-republish-endpoint: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
