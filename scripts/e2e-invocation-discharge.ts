/**
 * e2e (Phase 3, VC edition): the consent DISCHARGE round-trip — the MEDIUM+ capability step-up — live.
 *
 * The Sovereign's scope VC carries a `requiresDischarge` caveat. The Emissary presents it; the Warden detects
 * the consent gap and obtains a discharge from the DESIGNATED Signet (in-process here), bound to the act's
 * txn, then authorizes. Also checks decline and no-channel. Run:
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-discharge.ts
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
  PROTOCOL_VERSION,
  Sensitivity,
  type CapabilityInvocation,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService, type DischargeRequester } from '@hearthold/warden/evidence';
import { signDischarge, PinGate, DenyGate } from '@hearthold/sovereign/signet';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-discharge-e2e';
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
  await store.put({ id: 'art-sov', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.MEDIUM, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  const scopeVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema, config,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did, requiresDischarge: [{ by: sovId.did, predicate: 'cosign(act)' }] } },
  });
  await acceptCredential(emissary, scopeVc);

  const signetApproves: DischargeRequester = { requestDischarge: (req) => signDischarge(sovereign, sovId.name, new PinGate(PIN, PIN), req) };
  const signetDenies: DischargeRequester = { requestDischarge: (req) => signDischarge(sovereign, sovId.name, new DenyGate(), req) };

  const invocation = async (): Promise<CapabilityInvocation> => {
    const challenge = await requestProof(warden, { schema: authSchema, trustedIssuers: [sovId.did] });
    const presentation = await presentProof(emissary, challenge);
    return { type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation, act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: randomUUID(), args: { claim: 'resided in FR', spec: { kind: 'location' } } } };
  };

  line('\n════ the discharge round-trip ════');
  const granted = await new EvidenceService(warden, cfg, signetApproves).handleInvocation(await invocation(), emiId.did);
  check('MEDIUM+ invocation → Warden co-signs at the Signet → GRANTED', granted.status === 'granted', granted.reason ?? '');

  const deny1 = await new EvidenceService(warden, cfg, signetDenies).handleInvocation(await invocation(), emiId.did);
  check('Signet DECLINES → disclosure denied', deny1.status === 'denied' && /declined/.test(deny1.reason ?? ''), deny1.reason ?? '');

  const deny2 = await new EvidenceService(warden, cfg).handleInvocation(await invocation(), emiId.did);
  check('no discharge channel wired → denied (fail-closed)', deny2.status === 'denied' && /discharge channel/.test(deny2.reason ?? ''), deny2.reason ?? '');

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
