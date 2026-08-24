/**
 * e2e (regression): the cross-wallet authorization-schema alignment that invocation depends on.
 *
 * Reproduces Sevenfold's live "invocation refused: challenge not satisfied" (Table A, 2026-08-07) and its fix.
 * Schema DIDs are NOT content-addressed across wallets, so the Warden's invocation challenge and the Sovereign's
 * granted scope VC must reference the SAME schema DID or `verifyResponse` finds no match:
 *
 *   Case A (the bug)  — the Sovereign issues against its OWN schema (no canonical DID wired) → invoke DENIED,
 *                       reason "challenge not satisfied". This is exactly what Table A hit.
 *   Case B (the fix)  — the Sovereign issues against the WARDEN's canonical schema (the value an operator wires
 *                       into HEARTHOLD_AUTHORIZATION_SCHEMA_DID, now discoverable via `warden status`) → GRANTED.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invoke-schema-alignment.ts
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
import { CapabilityGrantStore, grantCapability } from '@hearthold/sovereign/capability-grants';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invoke-schema-alignment-e2e';

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

  // Register the Warden's canonical authorization schema; keep the Warden's current id set for the lazy
  // challenge mint. This DID is what `warden status` now surfaces and an operator wires to the Sovereign.
  await warden.keymaster.setCurrentId(wardenId.name);
  const wardenSchema = await ensureAuthorizationSchema(warden);
  await sovereign.keymaster.setCurrentId(sovId.name);
  const sovereignSchema = await ensureAuthorizationSchema(sovereign);
  line(`\nwarden authorization schema:    ${wardenSchema}`);
  line(`sovereign's own schema (≠):     ${sovereignSchema}`);
  check('the two wallets registered DIFFERENT schema DIDs (not content-addressed across wallets)', wardenSchema !== sovereignSchema);

  // Warden serves with the default challenge store (falls back to its own canonical schema — the verifier side).
  const challenges = new ChallengeStore(warden, config.registry, sovId.did);
  const handler = makeWardenHandler(new WardenService(warden), new DelegationStore(warden), new EvidenceService(warden, cfg), undefined, sovId.did, undefined, undefined, challenges);
  const wardenTransport = new DidCommTransport(warden, wardenId.name, config.nodeUrl);
  await wardenTransport.ready();
  const stopWarden = await wardenTransport.serve(handler, { pollMs: 1000 });
  const emiTransport = new DidCommTransport(emissary, emiId.name, config.nodeUrl);
  await emiTransport.ready();
  const grants = new CapabilityGrantStore(sovereign.dataFolder);

  try {
    line('\n════ Case A — Sovereign issues against its OWN schema (the Table-A bug) ════');
    const grantA = await grantCapability(sovereign, sovId.name, sovId.did, config, { holder: emiId.did, kinds: ['location'], ceiling: Sensitivity.LOW }, grants);
    check('the errant grant used the Sovereign\'s own schema (mismatched)', grantA.schemaDid === sovereignSchema, grantA.schemaDid);
    await acceptCredential(emissary, grantA.credentialDid);
    const a = await invokeEvidence(emissary, emiTransport, wardenId.did, { claim: 'resided in FR', kind: 'location' });
    const aDenied = a.type === 'hearthold/error' || (a.type === 'hearthold/evidence-response' && a.status === 'denied');
    const aReason = a.type === 'hearthold/evidence-response' && a.status === 'denied' ? a.reason : a.type === 'hearthold/error' ? a.reason : '';
    check('invocation DENIED for "challenge not satisfied" (reproduces the report)', aDenied && /challenge not satisfied/.test(aReason ?? ''), aReason);

    line('\n════ Case B — Sovereign issues against the WARDEN\'s canonical schema (the fix) ════');
    const grantB = await grantCapability(sovereign, sovId.name, sovId.did, { ...config, authorizationSchemaDid: wardenSchema }, { holder: emiId.did, kinds: ['location'], ceiling: Sensitivity.LOW }, grants);
    check('the fixed grant used the Warden\'s canonical schema', grantB.schemaDid === wardenSchema, grantB.schemaDid);
    await acceptCredential(emissary, grantB.credentialDid);
    const b = await invokeEvidence(emissary, emiTransport, wardenId.did, { claim: 'resided in FR', kind: 'location' });
    check('invocation GRANTED once the schemas align', b.type === 'hearthold/evidence-response' && b.status === 'granted', b.type === 'hearthold/error' ? b.reason : b.type === 'hearthold/evidence-response' ? b.reason ?? '' : '');
  } finally {
    await stopWarden();
  }

  line(`\n${failures === 0 ? '✅ SCHEMA ALIGNMENT — mismatched schema denies, canonical schema grants' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
