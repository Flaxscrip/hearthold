/**
 * e2e (revocation, VC edition): a scope VC carries a W3C StatusList pointer in its caveats; the Warden checks
 * it fail-closed at every invocation. Live against Archon.
 *
 * Present → invoke (allowed) → the Sovereign revokes the index → invoke (DENIED, live status re-check). The
 * unresolvable-status fail-closed path is covered by `e2e:status-list`. Run:
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-revoke.ts
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
  createStatusList,
  revokeStatusIndex,
  PROTOCOL_VERSION,
  Sensitivity,
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

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-revoke-e2e';
  const VAULT = 'hearthold:vault';
  const IDX = 4242;

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const emiId = await ensureIdentity(emissary, config);
  const sovId = await ensureIdentity(sovereign, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-sov', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  const { statusListCredential } = await createStatusList(sovereign, sovId.name, config);

  const scopeVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did, status: { statusListCredential, statusListIndex: IDX } } },
  });
  await acceptCredential(emissary, scopeVc);

  const evidence = new EvidenceService(warden, cfg);
  const invoke = async (): Promise<CapabilityInvocation> => {
    const challenge = await requestProof(warden, { schema: authSchema, trustedIssuers: [sovId.did] });
    const presentation = await presentProof(emissary, challenge);
    return { type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation, act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: randomUUID(), args: { claim: 'resided in FR', spec: { kind: 'location' } } } };
  };

  line('\n════ before revocation ════');
  const ok = await evidence.handleInvocation(await invoke(), emiId.did);
  check('unrevoked capability → GRANTED', ok.status === 'granted', ok.reason ?? '');

  line('\n════ the Sovereign revokes the capability ════');
  const r = await revokeStatusIndex(sovereign, sovId.name, statusListCredential, IDX);
  check('revocation published (bit set, new list version)', !r.alreadyRevoked && r.listVersion === 2, `v${r.listVersion}`);
  const revoked = await evidence.handleInvocation(await invoke(), emiId.did);
  check('revoked capability → DENIED (live status re-check)', revoked.status === 'denied' && /revoked/.test(revoked.reason ?? ''), revoked.reason ?? '');

  line('\n════ revocation-by-default: a non-revocable capability is refused ════');
  // No `config` and no explicit `status` ⇒ the capability carries no status pointer, so it can never be
  // revoked. The Warden's default policy (requireRevocableCapabilities) refuses it rather than trust it forever.
  // Issued to a FRESH holder so its wallet presents only this one VC (a clean, unambiguous presentation).
  const holder2 = await openKeymaster('verifier', config, pass);
  const h2Id = await ensureIdentity(holder2, config);
  const noStatusVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: h2Id.did, schemaDid: authSchema,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
  });
  await acceptCredential(holder2, noStatusVc);
  const invoke2 = async (): Promise<CapabilityInvocation> => {
    const challenge = await requestProof(warden, { schema: authSchema, trustedIssuers: [sovId.did] });
    const presentation = await presentProof(holder2, challenge);
    return { type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation, act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: randomUUID(), args: { claim: 'resided in FR', spec: { kind: 'location' } } } };
  };
  const nonRevocable = await evidence.handleInvocation(await invoke2(), h2Id.did);
  check('non-revocable capability (no status pointer) → DENIED', nonRevocable.status === 'denied' && /revocable|status pointer/.test(nonRevocable.reason ?? ''), nonRevocable.reason ?? '');

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
