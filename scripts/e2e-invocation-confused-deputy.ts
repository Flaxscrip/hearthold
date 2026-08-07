/**
 * e2e (RED TEST, VC edition): the confused deputy, against the capability cure.
 *
 * With capabilities-as-VCs the scope is presented via Archon `verifyResponse` — issuer-trusted +
 * holder-controlled — so the classic forgeries are unrepresentable: you cannot forge the Sovereign's
 * signature over a scope, and you cannot present a VC you do not hold. Each case here MUST be refused.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-confused-deputy.ts
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
import { EvidenceService } from '@hearthold/warden/evidence';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function mustDeny(name: string, status: string, reason = ''): void {
  const ok = status === 'denied';
  if (!ok) failures++;
  line(`${ok ? '✓ refused' : '✗ GRANTED (vulnerable)'} — ${name}${reason && ok ? ` [${reason}]` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-confused-deputy-e2e';
  const VAULT = 'hearthold:vault';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const emissary = await openKeymaster('emissary', config, pass); // legitimate holder
  const attacker = await openKeymaster('verifier', config, pass); // hostile third party
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const emiId = await ensureIdentity(emissary, config);
  const atkId = await ensureIdentity(attacker, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-victim', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.MEDIUM, ciphertext: 'secret', metadata: { witness: 'device-A' }, owner: sovId.did });

  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);

  // The Sovereign legitimately grants the Emissary a scope.
  const scopeVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
  });
  await acceptCredential(emissary, scopeVc);

  const present = async (holder: typeof emissary): Promise<string> => {
    const challenge = await requestProof(warden, { schema: authSchema, trustedIssuers: [sovId.did] });
    return presentProof(holder, challenge);
  };
  const act = () => ({ action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: randomUUID(), args: { claim: 'resided in FR', spec: { kind: 'location' } } });
  const evidence = new EvidenceService(warden, cfg);

  line('\n════ attacks the Warden must refuse ════');

  // A1 — no presentation at all.
  const a1 = await evidence.handleInvocation({ type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation: '', act: act() } as CapabilityInvocation, atkId.did);
  mustDeny('no capability presentation', a1.status, a1.reason);

  // A2 — the attacker SELF-ISSUES a scope granting itself SEALED over the victim, and presents it.
  const forged = await issueScopeCapability({
    issuer: attacker, issuerName: atkId.name, holder: atkId.did, schemaDid: authSchema,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did, audience: atkId.did } },
  });
  await acceptCredential(attacker, forged);
  const a2 = await evidence.handleInvocation({ type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation: await present(attacker), act: act() } as CapabilityInvocation, atkId.did);
  mustDeny('self-issued scope (not signed by the trusted Sovereign)', a2.status, a2.reason);

  // A3 — the attacker replays the Emissary's LEGITIMATE presentation as a different caller.
  const emiPresentation = await present(emissary);
  const a3 = await evidence.handleInvocation({ type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation: emiPresentation, act: act() } as CapabilityInvocation, atkId.did);
  mustDeny('captured legit presentation replayed by a non-holder', a3.status, a3.reason);

  // A4 — the attacker COPIES the Emissary's scope VC (shared wallet / HEARTHOLD_DATA_ROOT) and presents it
  // under its OWN DID. Possession of the VC plaintext must not be authority: subject ≠ responder.
  await acceptCredential(attacker, scopeVc).catch(() => undefined);
  const a4 = await evidence.handleInvocation({ type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation: await present(attacker), act: act() } as CapabilityInvocation, atkId.did);
  mustDeny("copied scope VC presented under the attacker's own DID (possession ≠ authority)", a4.status, a4.reason);

  line(`\n${failures === 0 ? '✅ ALL ATTACKS REFUSED' : `❌ ${failures} ATTACK(S) SUCCEEDED — vulnerability live`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
