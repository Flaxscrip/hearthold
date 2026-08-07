/**
 * e2e (audit-3 §3, live channel): the consent discharge over DIDComm — the wired step-up.
 *
 * The Warden's POLICY gate (`requiresHumanAt`, default MEDIUM) detects that a disclosure needs the owner's
 * consent — even though the capability carries NO `requiresDischarge` caveat — and obtains it from the owner's
 * Signet over the real control-plane channel (`makeDidcommDischargeRequester` → `hearthold/discharge-request`
 * → the Signet's `signDischarge` behind its proof-of-human gate). This is what `index.ts`/`control.ts` now wire.
 *
 *   ✓ Signet PIN matches → discharge signed → GRANTED.
 *   ✗ Signet declines (wrong PIN) → DENIED.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-discharge-didcomm.ts
 */
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureAuthorizationSchema,
  issueScopeCapability,
  acceptCredential,
  requestProof,
  presentProof,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
  Sensitivity,
  type CapabilityInvocation,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService, makeDidcommDischargeRequester } from '@hearthold/warden/evidence';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-discharge-didcomm-e2e';
  const VAULT = 'hearthold:vault';
  const PIN = '424242';

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const emiId = await ensureIdentity(emissary, config);
  const sovId = await ensureIdentity(sovereign, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-med', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.MEDIUM, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  // Ceiling SEALED, NO requiresDischarge caveat — the human gate is the Warden's policy, not the issuer's.
  const scopeVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema, config,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did } },
  });
  await acceptCredential(emissary, scopeVc);

  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, config.nodeUrl);
  await wardenTransport.ready();

  const invocation = async (): Promise<CapabilityInvocation> => {
    const challenge = await requestProof(warden, { schema: authSchema, trustedIssuers: [sovId.did] });
    const presentation = await presentProof(emissary, challenge);
    return { type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation, act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: randomUUID(), args: { claim: 'resided in FR', spec: { kind: 'location' } } } };
  };

  line('\n════ the consent discharge over DIDComm ════');

  // Signet online with the right PIN → the Warden's policy step-up succeeds over the wire.
  {
    const sig = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    await sig.ready();
    const stop = await sig.serve(makeSovereignHandler(sovereign, new PinGate(PIN, PIN)), { pollMs: 1000 });
    const evidence = new EvidenceService(warden, cfg, makeDidcommDischargeRequester(wardenTransport));
    const granted = await evidence.handleInvocation(await invocation(), emiId.did);
    await stop();
    check('MEDIUM disclosure → discharge obtained from the Signet over DIDComm → GRANTED', granted.status === 'granted', granted.reason ?? '');
  }

  // Signet declines (wrong PIN) → the disclosure is denied.
  {
    const sig = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    await sig.ready();
    const stop = await sig.serve(makeSovereignHandler(sovereign, new PinGate(PIN, 'wrong')), { pollMs: 1000 });
    const evidence = new EvidenceService(warden, cfg, makeDidcommDischargeRequester(wardenTransport));
    const denied = await evidence.handleInvocation(await invocation(), emiId.did);
    await stop();
    check('Signet declines the consent → DENIED', denied.status === 'denied', denied.reason ?? '');
  }

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
