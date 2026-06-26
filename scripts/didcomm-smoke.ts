/**
 * DIDComm v2 round-trip smoke test against the live Archon node (v0.10.0+ with the `didcomm`
 * profile). Validates the raw send → poll → receive → reply(thid) flow BEFORE we refactor
 * Hearthold's transport onto it.
 *
 *   Warden + Witness identities → publishDidComm (advertise endpoint) →
 *   Witness sendDidComm(req) → Warden polls receiveDidComm → Warden replies with thid →
 *   Witness polls receiveDidComm → correlates the reply by thid.
 *
 * NODE URL: DIDComm routes through Drawbridge's `/didcomm` mount, so point the keymaster at the
 * Drawbridge URL (default :4222), not the raw Gatekeeper (:4224). Confirm/adjust live — if identity
 * ops and didcomm don't both route through one URL on this node, we'll split them.
 *
 * Run (once flaxlap is on v0.10.0):  HEARTHOLD_PASSPHRASE=… npm run smoke:didcomm
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, openKeymaster, ensureIdentity, IDENTITY_NAME, type KeymasterHandle } from '@hearthold/core';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-didcomm');
const NODE_URL = process.env.HEARTHOLD_NODE_URL ?? 'http://flaxlap.local:4222';
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-didcomm-pass';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** Poll receiveDidComm until a message arrives or attempts run out. */
async function poll(h: KeymasterHandle, name: string, attempts = 12): Promise<any[]> {
  for (let i = 0; i < attempts; i += 1) {
    const msgs = await h.keymaster.receiveDidComm({ name });
    if (msgs.length > 0) return msgs;
    process.stdout.write(`  … polling ${name} (${i + 1}/${attempts})\n`);
    await sleep(2500);
  }
  return [];
}

/** Wait until `resolver` can see a DIDCommMessaging endpoint on `did` (publish propagation). */
async function waitForEndpoint(resolver: KeymasterHandle, did: string, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const doc = await resolver.keymaster.resolveDID(did).catch(() => null);
    const services = (doc as any)?.didDocument?.service ?? [];
    const has = services.some(
      (s: any) => /DIDCommMessaging/.test(JSON.stringify(s?.type)) || String(s?.id).endsWith('#didcomm'),
    );
    if (has) {
      process.stdout.write(`  endpoint visible after ~${i * 2}s\n`);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

async function main(): Promise<void> {
  const config = { ...loadConfig(), nodeUrl: NODE_URL, dataRoot: DATA_ROOT };
  process.stdout.write(`DIDComm smoke\n  node: ${NODE_URL}\n  data: ${DATA_ROOT}\n`);

  step('Provision identities + advertise DIDComm endpoints');
  const warden = await openKeymaster('warden', config, PASSPHRASE);
  const witness = await openKeymaster('witness', config, PASSPHRASE);
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  // Auto-discovery via the Drawbridge root mis-derives the URL and publishes key-only; fetch the
  // canonical endpoint and pass it explicitly so the DIDCommMessaging service block is written.
  const endpoint = await fetch(`${NODE_URL}/api/v1/didcomm-endpoint`)
    .then((r) => r.json())
    .then((j: any) => j.endpoint as string);
  process.stdout.write(`  didcomm endpoint: ${endpoint}\n`);
  await warden.keymaster.publishDidComm(endpoint, IDENTITY_NAME.warden);
  await witness.keymaster.publishDidComm(endpoint, IDENTITY_NAME.witness);
  // Wait for each side to see the other's published endpoint before sending.
  const wOk = await waitForEndpoint(witness, wardenId.did);
  const aOk = await waitForEndpoint(warden, witnessId.did);
  check('both DIDComm endpoints resolvable', wOk && aOk);

  step('Witness → Warden: send a request');
  const reqThid = `hearthold-smoke-${witnessId.did.slice(-8)}`;
  await witness.keymaster.sendDidComm(
    { type: 'https://hearthold.dev/smoke/1', thid: reqThid, body: { text: 'hello warden', n: 7 } },
    wardenId.did,
    { name: IDENTITY_NAME.witness },
  );
  check('send accepted by relay', true);

  step('Warden polls its mailbox');
  const inbound = await poll(warden, IDENTITY_NAME.warden);
  const req = inbound.find((m) => m.message?.thid === reqThid);
  check('warden received the request', req != null);
  process.stdout.write(`  metadata: ${JSON.stringify(req?.metadata)}\n`);
  const reqSender = String(req?.metadata?.sender ?? '').split('#')[0];
  check('sender authenticated as the Witness', reqSender === witnessId.did && req?.metadata?.authenticated === true);
  check('body intact', req?.message?.body?.text === 'hello warden');

  step('Warden → Witness: reply correlated by thid');
  await warden.keymaster.sendDidComm(
    { type: 'https://hearthold.dev/smoke-reply/1', thid: reqThid, body: { ok: true } },
    witnessId.did,
    { name: IDENTITY_NAME.warden },
  );
  const replies = await poll(witness, IDENTITY_NAME.witness);
  const reply = replies.find((m) => m.message?.thid === reqThid);
  check('witness received the correlated reply', reply != null);
  const replySender = String(reply?.metadata?.sender ?? '').split('#')[0];
  check('reply authenticated as the Warden', replySender === wardenId.did && reply?.metadata?.authenticated === true);

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\nsmoke error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
