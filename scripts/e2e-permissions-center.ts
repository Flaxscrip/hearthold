/**
 * e2e (Phase 4): the permissions center — grant → list → invoke → REVOKE → list → invoke DENIED.
 *
 * The Sovereign records each grant, can list its state (active/expired/revoked), and revokes by flipping the
 * capability's status bit — which the Warden's revocation-by-default check refuses at the very next invocation.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-permissions-center.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureAuthorizationSchema,
  acceptCredential,
  DidCommTransport,
  Sensitivity,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { WardenService } from '@hearthold/warden/service';
import { EvidenceService } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';
import { ChallengeStore } from '@hearthold/warden/challenge-store';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { invokeEvidence } from '@hearthold/emissary/invoke';
import { CapabilityGrantStore, grantCapability, revokeCapability, grantState } from '@hearthold/sovereign/capability-grants';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-permissions-center-e2e';
  const VAULT = 'hearthold:vault';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const emiId = await ensureIdentity(emissary, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-fr', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  line('\n════ 1. GRANT + LIST ════');
  // The Warden's authorization schema is canonical; hand it to the Sovereign so its scope VC matches the
  // Warden's challenge (schema DIDs are not content-addressed across wallets — HEARTHOLD_AUTHORIZATION_SCHEMA_DID
  // carries this in a real deployment).
  await warden.keymaster.setCurrentId(wardenId.name);
  const sharedSchema = await ensureAuthorizationSchema(warden);
  const grants = new CapabilityGrantStore(sovereign.dataFolder);
  const grant = await grantCapability(sovereign, sovId.name, sovId.did, { ...config, authorizationSchemaDid: sharedSchema }, { holder: emiId.did, kinds: ['location'], ceiling: Sensitivity.LOW }, grants);
  await acceptCredential(emissary, grant.credentialDid);
  const list1 = await grants.list();
  const rec1 = list1.find((g) => g.credentialDid === grant.credentialDid);
  check('the grant is recorded in the inventory, state=active', !!rec1 && grantState(rec1) === 'active', rec1 ? grantState(rec1) : 'missing');

  // Warden serves.
  const challenges = new ChallengeStore(warden, config.registry, sovId.did);
  const handler = makeWardenHandler(new WardenService(warden), new DelegationStore(warden), new EvidenceService(warden, cfg), undefined, sovId.did, undefined, undefined, challenges);
  const wardenTransport = new DidCommTransport(warden, wardenId.name, config.nodeUrl);
  await wardenTransport.ready();
  const stopWarden = await wardenTransport.serve(handler, { pollMs: 1000 });
  const emiTransport = new DidCommTransport(emissary, emiId.name, config.nodeUrl);
  await emiTransport.ready();

  try {
    line('\n════ 2. INVOKE (granted) ════');
    const before = await invokeEvidence(emissary, emiTransport, wardenId.did, { claim: 'resided in FR', kind: 'location' });
    check('invocation GRANTED while the capability is active', before.type === 'hearthold/evidence-response' && before.status === 'granted', before.type === 'hearthold/error' ? before.reason : before.type === 'hearthold/evidence-response' ? before.reason ?? '' : '');

    line('\n════ 3. REVOKE + LIST ════');
    const r = await revokeCapability(sovereign, sovId.name, grants, grant.credentialDid);
    check('revoke succeeds', r.revoked === true, r.reason ?? '');
    const rec2 = (await grants.list()).find((g) => g.credentialDid === grant.credentialDid);
    check('the inventory now shows state=revoked', !!rec2 && grantState(rec2) === 'revoked', rec2 ? grantState(rec2) : 'missing');

    line('\n════ 4. INVOKE (denied — revoked) ════');
    const after = await invokeEvidence(emissary, emiTransport, wardenId.did, { claim: 'resided in FR', kind: 'location' });
    const denied = after.type === 'hearthold/error' || (after.type === 'hearthold/evidence-response' && after.status === 'denied');
    const reason = after.type === 'hearthold/evidence-response' && after.status === 'denied' ? after.reason : after.type === 'hearthold/error' ? after.reason : '';
    check('invocation DENIED after revocation (revocation-by-default)', denied && /revoked/.test(reason), reason);
  } finally {
    await stopWarden();
  }

  line(`\n${failures === 0 ? '✅ PERMISSIONS CENTER — grant, list, invoke, revoke, deny — end to end' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
