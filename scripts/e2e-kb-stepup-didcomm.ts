/**
 * e2e: the live factor-2 channel — the Warden's step-up approver reaches the member's Signet over
 * DIDComm (the direct, out-of-band channel the Mage is never on). Proves the real round-trip: the
 * Warden asks, the Signet gates on a fresh proof-of-human, and approve/deny flows back.
 *
 * Live (needs the Archon node). Run:  npm run e2e:kb-stepup-didcomm
 */
import { DidCommTransport, openKeymaster, ensureIdentity, loadConfig, IDENTITY_NAME } from '@hearthold/core';
import { makeDidcommActionApprover } from '@hearthold/warden/kb';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-kb-stepup-dc';
  const PIN = '2468';

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass); // the member; her Signet approves
  await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);

  // Publish both endpoints up front (so the Warden can resolve the member's Signet).
  await new DidCommTransport(alice, IDENTITY_NAME.sovereign, config.nodeUrl).ready();
  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, config.nodeUrl);
  await wardenTransport.ready();
  const approver = makeDidcommActionApprover(wardenTransport, 30_000);
  const req = { member: aliceId.did, action: 'write', resource: 'sphere-kb', summary: 'contribute to sphere-kb: “Elections close Friday.”' };

  process.stdout.write('\n▸ Member approves the step-up (fresh proof-of-human)\n');
  {
    const sovT = new DidCommTransport(alice, IDENTITY_NAME.sovereign, config.nodeUrl);
    const stop = await sovT.serve(makeSovereignHandler(alice, new PinGate(PIN, PIN)), { pollMs: 1000 });
    const ok = await approver.requestActionApproval(req);
    stop();
    assert(ok === true, 'the Warden’s step-up reaches the Signet and the member approves → authorized');
  }

  process.stdout.write('\n▸ Member declines the step-up\n');
  {
    const sovT = new DidCommTransport(alice, IDENTITY_NAME.sovereign, config.nodeUrl);
    const stop = await sovT.serve(makeSovereignHandler(alice, new PinGate(PIN, 'wrong')), { pollMs: 1000 });
    const ok = await approver.requestActionApproval(req);
    stop();
    assert(ok === false, 'a declined step-up flows back as not-authorized');
  }

  process.stdout.write('\n✓ Live factor-2 channel: Warden → member’s Signet → approve/deny, direct and out-of-band (no Mage)\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-stepup-didcomm: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
