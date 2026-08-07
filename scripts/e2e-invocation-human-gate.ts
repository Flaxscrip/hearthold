/**
 * e2e (audit-3 §3): the human gate is a WARDEN POLICY, not an issuer option.
 *
 * The capability here carries NO `requiresDischarge` caveat — exactly the shape every prior e2e minted. Before
 * this fix, a `ceiling: SEALED` capability disclosed SEALED artefacts with no human in the loop. Now the Warden
 * policy (`requiresHumanAt`, default MEDIUM) forces the OWNER's fresh consent for a sensitive disclosure:
 *
 *   ✗ MEDIUM disclosure, no discharge channel → DENIED (fail-closed — SEALED no longer discloses with no human).
 *   ✓ MEDIUM disclosure, owner's Signet consents → GRANTED.
 *   ✓ LOW disclosure, no channel → GRANTED (the gate is sensitivity-scaled, not a blanket lock).
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-human-gate.ts
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
import { signDischarge, PinGate } from '@hearthold/sovereign/signet';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-human-gate-e2e';
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
  await store.put({ id: 'art-low', kind: 'activity', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'y', metadata: { witness: 'device-A' }, owner: sovId.did });

  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  // Ceiling SEALED, NO requiresDischarge caveat — the issuer attached no human gate at all.
  const scopeVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did } },
  });
  await acceptCredential(emissary, scopeVc);

  const signetApproves: DischargeRequester = { requestDischarge: (req) => signDischarge(sovereign, sovId.name, new PinGate(PIN, PIN), req) };

  const invocation = async (kind: string, claim: string): Promise<CapabilityInvocation> => {
    const challenge = await requestProof(warden, { schema: authSchema, trustedIssuers: [sovId.did] });
    const presentation = await presentProof(emissary, challenge);
    return { type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation, act: { action: 'prove', target: 'hearthold:vault:' + kind, nonce: randomUUID(), txn: randomUUID(), args: { claim, spec: { kind } } } };
  };

  line('\n════ the Warden policy human gate ════');

  // MEDIUM, no channel → denied by policy (the headline: SEALED-ceiling capability, no caveat, no human).
  const noChannel = await new EvidenceService(warden, cfg).handleInvocation(await invocation('location', 'resided in FR'), emiId.did);
  check('MEDIUM disclosure with no discharge channel → DENIED (no caveat, yet human required)', noChannel.status === 'denied' && /discharge channel/.test(noChannel.reason ?? ''), noChannel.reason ?? '');

  // MEDIUM, owner consents at the Signet → granted.
  const consented = await new EvidenceService(warden, cfg, signetApproves).handleInvocation(await invocation('location', 'resided in FR'), emiId.did);
  check('MEDIUM disclosure with the owner’s Signet consent → GRANTED', consented.status === 'granted', consented.reason ?? '');

  // LOW, no channel → granted (below the policy threshold; no human needed for a low-sensitivity fact).
  const low = await new EvidenceService(warden, cfg).handleInvocation(await invocation('activity', 'was active'), emiId.did);
  check('LOW disclosure with no channel → GRANTED (gate is sensitivity-scaled)', low.status === 'granted', low.reason ?? '');

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
