/**
 * e2e: the Sovereign daemon's mid-session credential refresh (Aegis-reported sharp edge).
 *
 * The keymaster caches the wallet in memory at open. A long-lived `sovereign serve`/`control` daemon
 * therefore does NOT see a credential accepted mid-session by a SEPARATE process (`sovereign accept`,
 * which writes wallet.json and exits) — the credential is invisible to `presentProof` until a restart.
 *
 * This reproduces that staleness (a warm daemon handle cannot present a just-accepted credential) and
 * proves the fix: re-opening a fresh handle (what `makeSovereignHandler`'s `reloadForProof` does before
 * presenting) reads the current wallet from disk, so the credential presents without a restart.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-sovereign-refresh.ts
 */
import {
  loadConfig,
  openKeymaster,
  openKeymasterFresh,
  ensureIdentity,
  acceptCredential,
  requestProof,
  presentProof,
  verifyProof,
  PROTOCOL_VERSION,
  type KeymasterHandle,
} from '@hearthold/core';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { type: { type: 'string' }, tier: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
} as const;

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-sovereign-refresh';

  step('Provision: issuer (sphere), verifier, and the Sovereign');
  const issuer: KeymasterHandle = await openKeymaster('warden', config, pass);
  const verifier: KeymasterHandle = await openKeymaster('emissary', config, pass);
  const issuerId = await ensureIdentity(issuer, config);
  await ensureIdentity(verifier, config);

  // The long-lived daemon: open once and WARM the wallet cache (this is the process that goes stale).
  const daemon: KeymasterHandle = await openKeymaster('sovereign', config, pass);
  const sovId = await ensureIdentity(daemon, config); // populates the daemon's in-memory _walletCache
  check('daemon handle open with a warm wallet cache', sovId.did.startsWith('did:'));

  step('Issuer issues a credential to the Sovereign (not yet accepted)');
  const schemaDid = await issuer.keymaster.createSchema(SCHEMA);
  const bound = await issuer.keymaster.bindCredential(sovId.did, { schema: schemaDid, claims: { type: 'MembershipTier', tier: 'Gold' } });
  const credDid = await issuer.keymaster.issueCredential(bound, { schema: schemaDid });
  check('credential issued', credDid.startsWith('did:'));

  step('A SEPARATE process accepts it into the Sovereign wallet (mirrors `sovereign accept`)');
  const acceptor: KeymasterHandle = await openKeymaster('sovereign', config, pass); // distinct instance, same wallet.json
  const accepted = await acceptCredential(acceptor, credDid);
  check('credential accepted + written to wallet.json by the separate process', accepted === true);

  const tryPresent = async (holder: KeymasterHandle): Promise<boolean> => {
    try {
      const ch = await requestProof(verifier, { schema: schemaDid, trustedIssuers: [issuerId.did] });
      const resp = await presentProof(holder, ch);
      const v = await verifyProof(verifier, resp, { trustedIssuers: [issuerId.did], schema: schemaDid });
      return v.ok;
    } catch {
      return false; // createResponse throws when no held credential matches — also "cannot present"
    }
  };

  step('Reproduce the sharp edge: the WARM daemon handle cannot present the mid-session credential');
  const staleOk = await tryPresent(daemon);
  check('stale daemon handle FAILS to present (reproduces the cache staleness)', staleOk === false);

  step('The fix: a reloaded handle (exactly what reloadForProof does) reads wallet.json fresh and presents it');
  const reloaded: KeymasterHandle = await openKeymasterFresh('sovereign', config, pass);
  const freshOk = await tryPresent(reloaded);
  check('reloaded handle PRESENTS the credential → verifier accepts (no restart needed)', freshOk === true);

  // Drive the REAL daemon handler (not just the reload mechanism): the STALE base handle is what the
  // daemon captured at startup; the reopen thunk is what `serve`/`control` pass in. Auto-approving PIN.
  const handlerPresents = async (reopen?: () => Promise<KeymasterHandle>): Promise<boolean> => {
    const handler = makeSovereignHandler(daemon /* stale base */, new PinGate('4242', '4242'), reopen);
    const challengeDid = await requestProof(verifier, { schema: schemaDid, trustedIssuers: [issuerId.did] });
    const reply = (await handler({ type: 'hearthold/proof-request', version: PROTOCOL_VERSION, challengeDid, schema: schemaDid }, issuerId.did)) as
      | { type: string; responseDid?: string }
      | null;
    if (reply?.type !== 'hearthold/proof-presentation' || !reply.responseDid) return false;
    return (await verifyProof(verifier, reply.responseDid, { trustedIssuers: [issuerId.did], schema: schemaDid })).ok;
  };

  step('Through the REAL handler with a stale base handle: WITHOUT reopen it cannot present (the bug)');
  check('handler without a reopen thunk FAILS on the stale base handle', (await handlerPresents(undefined)) === false);

  step('Through the REAL handler with the reopen thunk (what the daemon wires): it presents (the guard)');
  check(
    'handler WITH reopen presents the mid-session credential despite the stale base handle',
    (await handlerPresents(() => openKeymasterFresh('sovereign', config, pass))) === true,
  );

  process.stdout.write(
    failures === 0
      ? '\n✓ staleness reproduced AND fixed: the daemon presents a mid-session credential after a wallet reload\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-sovereign-refresh: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
