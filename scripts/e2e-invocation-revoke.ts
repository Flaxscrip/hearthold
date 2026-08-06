/**
 * e2e (revocation): a capability carries a W3C StatusList pointer in its committed caveats; the Warden checks
 * it fail-closed at every invocation. Live against Archon.
 *
 * Mint → invoke (allowed) → the Sovereign revokes the capability's index → invoke (DENIED) → and a capability
 * whose status list is unresolvable is DENIED (never fails open). Run:
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-revoke.ts
 */
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  mintRootCapability,
  delegateCapability,
  discloseChain,
  createStatusList,
  revokeStatusIndex,
  AUTHORIZATION_TYPE,
  PROTOCOL_VERSION,
  Sensitivity,
  type CapabilityHandle,
  type CapabilityInvocation,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService } from '@hearthold/warden/evidence';

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
  const pass = 'hearthold-invocation-revoke-e2e';
  const reg = config.registry;
  const VAULT = 'hearthold:vault';
  const IDX = 4242;

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  await ensureIdentity(warden, config);
  const emiId = await ensureIdentity(emissary, config);
  const sovId = await ensureIdentity(sovereign, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-sov', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  const { statusListCredential } = await createStatusList(sovereign, sovId.name, config);
  const evidence = new EvidenceService(warden, cfg);

  line(`\n════ capability carries a StatusList pointer (index ${IDX}) ════`);
  const root = await mintRootCapability({
    issuer: sovereign, issuerName: sovId.name, holder: sovId.did,
    capability: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
    registry: reg,
  });
  const emi = await delegateCapability({
    issuer: sovereign, issuerName: sovId.name, parent: root, holder: emiId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did, status: { statusListCredential, statusListIndex: IDX } } },
    registry: reg,
  });
  const invoke = (h: CapabilityHandle): CapabilityInvocation => ({
    type: 'hearthold/invocation', version: PROTOCOL_VERSION, capability: cred(h),
    act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: randomUUID(), args: { claim: 'resided in FR', spec: { kind: 'location' } } },
    disclosed: discloseChain(h, root), orderedCaveats: [h.capability.caveats, root.capability.caveats],
  });

  line('\n════ before revocation ════');
  const ok = await evidence.handleInvocation(invoke(emi), emiId.did);
  check('unrevoked capability → GRANTED', ok.status === 'granted', ok.reason ?? '');

  line('\n════ the Sovereign revokes the capability ════');
  const r = await revokeStatusIndex(sovereign, sovId.name, statusListCredential, IDX);
  check('revocation published (bit set, new list version)', !r.alreadyRevoked && r.listVersion === 2, `v${r.listVersion}`);
  const revoked = await evidence.handleInvocation(invoke(emi), emiId.did);
  check('revoked capability → DENIED', revoked.status === 'denied' && /revoked/.test(revoked.reason ?? ''), revoked.reason ?? '');

  line('\n════ fail-closed: unresolvable status list ════');
  const emiBad = await delegateCapability({
    issuer: sovereign, issuerName: sovId.name, parent: root, holder: emiId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did, status: { statusListCredential: root.issued.vcDid, statusListIndex: 7 } } },
    registry: reg,
  });
  const failClosed = await evidence.handleInvocation(invoke(emiBad), emiId.did);
  check('status unavailable → DENIED (never fails open)', failClosed.status === 'denied' && /unavailable|fail-closed/.test(failClosed.reason ?? ''), failClosed.reason ?? '');

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
