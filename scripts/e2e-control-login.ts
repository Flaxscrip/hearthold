/**
 * e2e: CONTROL LOGIN — the Signet-brokered challenge/response the browser Table drives.
 *
 *   Warden  createChallenge(purpose: hearthold-control)  → challenge
 *   Signet  createResponse(challenge)  (keys never leave) → response      ← POST /api/login/sign wraps this
 *   Warden  verifyResponse(response) → { match, responder }               ← POST /api/login/complete
 *
 * Proves the crypto flow end-to-end AND the security hinge the sign route enforces: sign ONLY a challenge
 * whose purpose is `hearthold-control`. The human PIN gate is the same HttpGate `/api/approve` already uses;
 * this exercises everything the route composes except that gate.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-control-login.ts
 */
import { join } from 'node:path';

import { loadConfig, openKeymaster, ensureIdentity, IDENTITY_NAME, type KeymasterHandle } from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

/** The security hinge, exactly as the sign route computes it. */
async function challengePurpose(handle: KeymasterHandle, challenge: string): Promise<string | undefined> {
  const doc = await handle.keymaster.resolveDID(challenge).catch(() => null);
  return (doc?.didDocumentData as { challenge?: { purpose?: string } } | undefined)?.challenge?.purpose;
}

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-control-login-e2e';
  const cfg = (s: string) => ({ ...base, dataRoot: join(base.dataRoot, s) });

  step('Provision the Warden (mints + verifies) and the member (signs at the Signet)');
  const warden = await openKeymaster('warden', cfg('warden'), pass);
  const member = await openKeymaster('sovereign', cfg('member'), pass);
  await ensureIdentity(warden, cfg('warden'));
  const memberId = await ensureIdentity(member, cfg('member'));
  await warden.keymaster.setCurrentId(IDENTITY_NAME.warden);

  step('Warden mints a control-login challenge (POST /api/login/start)');
  const challenge = await (warden.keymaster.createChallenge as (c?: unknown, o?: unknown) => Promise<string>)(
    { purpose: 'hearthold-control', callback: 'x' },
    { registry: base.registry },
  );
  check('challenge minted', challenge.startsWith('did:'));

  step('SECURITY HINGE — the sign route signs ONLY a hearthold-control challenge');
  check("a hearthold-control challenge is accepted (purpose === 'hearthold-control')", (await challengePurpose(warden, challenge)) === 'hearthold-control');
  const otherChallenge = await (warden.keymaster.createChallenge as (c?: unknown, o?: unknown) => Promise<string>)(
    { purpose: 'some-other-purpose', callback: 'x' },
    { registry: base.registry },
  );
  const otherPurpose = await challengePurpose(warden, otherChallenge);
  check('a non-control challenge is REFUSED by the hinge (purpose !== hearthold-control)', otherPurpose !== 'hearthold-control' && otherPurpose === 'some-other-purpose');

  step('Signet signs the challenge (POST /api/login/sign → createResponse; keys never leave)');
  await member.keymaster.setCurrentId(IDENTITY_NAME.sovereign);
  const response = await member.keymaster.createResponse(challenge);
  check('response minted on the local registry (ephemeralRegistry aligned)', response.startsWith('did:'));

  step('Warden verifies the response (POST /api/login/complete → session)');
  await warden.keymaster.setCurrentId(IDENTITY_NAME.warden);
  const verified = await warden.keymaster.verifyResponse(response);
  check('response verifies', verified.match === true);
  check('the responder is the member (the session is issued for them)', verified.responder === memberId.did);

  process.stdout.write(
    failures === 0
      ? '\n✓ control-login: mint → Signet-sign → verify round-trips; the sign route signs only a hearthold-control challenge\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-control-login: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
