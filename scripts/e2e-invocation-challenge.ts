/**
 * e2e: the Warden-minted challenge (audit-3 §1). A presentation must answer a challenge the WARDEN minted —
 * fresh and single-use — so it is not a permanent bearer token, and the audience binding does not rest on the
 * unverified accident that `createResponse` encrypts to the challenge's controller (assumption A1).
 *
 *   ✓ honest: a fresh Warden challenge → granted, and the challenge is consumed.
 *   ✗ replay: a second presentation of the (burned) challenge → refused.
 *   ✗ self-minted: a challenge the HOLDER minted (not the Warden) → refused, regardless of whether A1 holds.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-challenge.ts
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
import { ChallengeStore } from '@hearthold/warden/challenge-store';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function expect(name: string, pass: boolean, detail = ''): void {
  if (!pass) failures++;
  line(`${pass ? '✓' : '✗ FAIL'} — ${name}${detail ? ` [${detail}]` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-challenge-e2e';
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
  await store.put({ id: 'art-1', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  const scopeVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
  });
  await acceptCredential(emissary, scopeVc);

  const challenges = new ChallengeStore(warden, config.registry, sovId.did);
  const gate = challenges.gate('invocation');
  const evidence = new EvidenceService(warden, cfg);
  const act = () => ({ action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: randomUUID(), args: { claim: 'resided in FR', spec: { kind: 'location' } } });
  const inv = (presentation: string): CapabilityInvocation => ({ type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation, act: act() });

  line('\n════ Warden-minted challenge ════');

  // Honest: a fresh Warden challenge, answered by the holder → granted.
  const wardenChallenge = await challenges.mintForPurpose('invocation');
  const goodPresentation = await presentProof(emissary, wardenChallenge);
  const r1 = await evidence.handleInvocation(inv(goodPresentation), emiId.did, gate);
  expect('a fresh Warden-minted challenge is granted', r1.status === 'granted', r1.reason ?? r1.status);

  // Replay: the challenge was single-use — a second presentation of it is refused (bearer-token defeat).
  const replayPresentation = await presentProof(emissary, wardenChallenge);
  const r2 = await evidence.handleInvocation(inv(replayPresentation), emiId.did, gate);
  expect('a replay of the burned challenge is refused', r2.status === 'denied', r2.reason ?? r2.status);

  // Self-minted: a challenge the HOLDER minted is not one we minted → refused, whether or not A1 holds.
  const selfChallenge = await requestProof(emissary, { schema: authSchema, trustedIssuers: [sovId.did] });
  const selfPresentation = await presentProof(emissary, selfChallenge);
  const r3 = await evidence.handleInvocation(inv(selfPresentation), emiId.did, gate);
  expect('a holder-self-minted challenge is refused', r3.status === 'denied', r3.reason ?? r3.status);

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
