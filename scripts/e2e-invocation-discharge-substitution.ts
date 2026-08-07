/**
 * e2e (RED TEST, audit-4 §1): a consent discharge cannot be SUBSTITUTED across meaning within one txn.
 *
 * The holder names the txn, and can reach the owner's Signet. Before this fix, it could get a discharge for a
 * benign, low-sensitivity claim ("Sync activity summary"), then staple that discharge onto a SEALED disclosure
 * with the same txn — the human approved words unrelated to the act they authorized. Now the discharge is bound
 * to a digest over claim/kind/owner/audience/sensitivity, recomputed from the ACTUAL act, so:
 *
 *   ✗ a discharge approved for a benign claim → DENIED on the SEALED act (digest mismatch).
 *   ✓ a discharge bound to the actual disclosure → GRANTED (consent matches the act).
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-discharge-substitution.ts
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
  POLICY_CONSENT_PREDICATE,
  PROTOCOL_VERSION,
  Sensitivity,
  type CapabilityInvocation,
  type Discharge,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService } from '@hearthold/warden/evidence';
import { signDischarge, PinGate } from '@hearthold/sovereign/signet';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-discharge-substitution-e2e';
  const VAULT = 'hearthold:vault';
  const PIN = '424242';
  const CLAIM = 'resided in FR';

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const emiId = await ensureIdentity(emissary, config);
  const sovId = await ensureIdentity(sovereign, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-sealed', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.SEALED, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  const scopeVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema, config,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did } },
  });
  await acceptCredential(emissary, scopeVc);

  const T = randomUUID(); // the requester-chosen txn — the same T for both the discharge and the act
  const present = async (): Promise<string> => presentProof(emissary, await requestProof(warden, { schema: authSchema, trustedIssuers: [sovId.did] }));
  const invoke = async (discharges: Discharge[]): Promise<CapabilityInvocation> => ({
    type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation: await present(),
    act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: T, args: { claim: CLAIM, spec: { kind: 'location' } } },
    discharges,
  });

  // The owner's Signet signs whatever it is shown (a PIN that always approves). The digest binds the result.
  const sign = (req: Parameters<typeof signDischarge>[3]): Promise<Discharge | null> => signDischarge(sovereign, sovId.name, new PinGate(PIN, PIN), req);
  const base = { txn: T, by: sovId.did, predicate: POLICY_CONSENT_PREDICATE, owner: sovId.did, audience: emiId.did };
  const dBenign = await sign({ ...base, claim: 'Sync activity summary', kind: 'activity', sensitivity: Sensitivity.LOW });
  const dCorrect = await sign({ ...base, claim: CLAIM, kind: 'location', sensitivity: Sensitivity.SEALED });

  // No discharge channel is wired — a pre-obtained discharge must stand on its own (the attacker holds it).
  const evidence = new EvidenceService(warden, cfg);

  line('\n════ discharge substitution ════');
  const substituted = await evidence.handleInvocation(await invoke([dBenign!]), emiId.did);
  check('benign consent cannot authorize a SEALED disclosure (digest mismatch)', substituted.status === 'denied', substituted.reason ?? '');

  const legit = await evidence.handleInvocation(await invoke([dCorrect!]), emiId.did);
  check('consent bound to the actual disclosure authorizes it', legit.status === 'granted', legit.reason ?? '');

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
