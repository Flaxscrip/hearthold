/**
 * e2e (Phase 3): the consent DISCHARGE round-trip — the MEDIUM+ capability step-up — live against Archon.
 *
 * A capability carries a `requiresDischarge` caveat (owner's Signet must co-sign). The Emissary invokes with
 * NO discharge; the Warden detects the gap and obtains a discharge from the DESIGNATED Signet (in-process
 * here, over DIDComm in the daemon), bound to the act's txn, then authorizes. This is the macaroon third-party
 * caveat made real — replacing the requester-chosen approver. Also checks decline and no-channel. Run:
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-discharge.ts
 */
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  mintRootCapability,
  delegateCapability,
  discloseChain,
  AUTHORIZATION_TYPE,
  PROTOCOL_VERSION,
  Sensitivity,
  type CapabilityHandle,
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
const cred = (h: CapabilityHandle): CapabilityInvocation['capability'] => ({
  type: ['VerifiableCredential', AUTHORIZATION_TYPE],
  credentialSubject: h.capability,
});

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-discharge-e2e';
  const reg = config.registry;
  const VAULT = 'hearthold:vault';
  const PIN = '424242';

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  await ensureIdentity(warden, config);
  const emiId = await ensureIdentity(emissary, config);
  const sovId = await ensureIdentity(sovereign, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  // A MEDIUM location artefact owned by the Sovereign.
  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-sov', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.MEDIUM, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  // The owner's Signet channels — the Warden reaches the DESIGNATED party (sovId), never the Emissary.
  const signetApproves: DischargeRequester = { requestDischarge: (req) => signDischarge(sovereign, sovId.name, new PinGate(PIN, PIN), req) };
  const signetDenies: DischargeRequester = { requestDischarge: (req) => signDischarge(sovereign, sovId.name, new DenyGate(), req) };

  line(`\n════ capability requires the owner's Signet co-sign (requiresDischarge) ════`);
  const root = await mintRootCapability({
    issuer: sovereign, issuerName: sovId.name, holder: sovId.did,
    capability: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
    registry: reg,
  });
  const emi = await delegateCapability({
    issuer: sovereign, issuerName: sovId.name, parent: root, holder: emiId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did, requiresDischarge: [{ by: sovId.did, predicate: 'cosign(act)' }] } },
    registry: reg,
  });

  const invocation = (txn: string): CapabilityInvocation => ({
    type: 'hearthold/invocation', version: PROTOCOL_VERSION, capability: cred(emi),
    act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn, args: { claim: 'resided in FR', spec: { kind: 'location' } } },
    disclosed: discloseChain(emi, root), orderedCaveats: [emi.capability.caveats, root.capability.caveats],
  });

  line('\n════ the discharge round-trip ════');
  // No discharge on the wire — the Warden fetches it from the owner's Signet and retries.
  const approved = new EvidenceService(warden, cfg, undefined, signetApproves);
  const granted = await approved.handleInvocation(invocation(randomUUID()), emiId.did);
  check('MEDIUM+ invocation with NO discharge → Warden co-signs at the Signet → GRANTED', granted.status === 'granted', granted.reason ?? '');

  const declined = new EvidenceService(warden, cfg, undefined, signetDenies);
  const deny1 = await declined.handleInvocation(invocation(randomUUID()), emiId.did);
  check('Signet DECLINES → disclosure denied', deny1.status === 'denied' && /declined/.test(deny1.reason ?? ''), deny1.reason ?? '');

  const noChannel = new EvidenceService(warden, cfg);
  const deny2 = await noChannel.handleInvocation(invocation(randomUUID()), emiId.did);
  check('no discharge channel wired → denied (fail-closed)', deny2.status === 'denied' && /discharge channel/.test(deny2.reason ?? ''), deny2.reason ?? '');

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
