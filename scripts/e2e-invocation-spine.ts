/**
 * e2e (the SPINE): grant → invoke → proof, end to end over DIDComm — the whole invocation feature.
 *
 *   1. GRANT   the Sovereign grants the Emissary a revocable, LOW-ceiling scope capability (`capability:grant`).
 *   2. INVOKE  the Emissary presents it to prove a fact — the shipped `invokeEvidence` client path
 *              (challenge-request → present → hearthold/invocation) — and the Warden mints a signed evidence graph.
 *   3. VERIFY  a third party checks the graph; trust rests on the WARDEN's signature, never its word.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-spine.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureAuthorizationSchema,
  issueScopeCapability,
  acceptCredential,
  requestProof,
  presentProof,
  verifyProof,
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

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-spine-e2e';
  const VAULT = 'hearthold:vault';
  const CLAIM = 'resided in FR during 2026-H1';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const emiId = await ensureIdentity(emissary, config);
  await ensureIdentity(verifier, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  // A routine LOW 'location' artefact — the baseline grant discloses it with no step-up.
  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-fr', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  line('\n════ 1. GRANT — the Sovereign grants the Emissary a scope capability ════');
  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const capDid = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema, config,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.LOW, owner: sovId.did, kinds: ['location'], expires } },
    validUntil: expires,
  });
  await acceptCredential(emissary, capDid); // the Emissary holds it (`emissary accept <cap>`)
  check('the Emissary holds a revocable, LOW-ceiling location capability', capDid.startsWith('did:'));

  line('\n════ 2. Warden serves · 3. INVOKE — the Emissary proves a fact ════');
  const challenges = new ChallengeStore(warden, config.registry, sovId.did);
  const handler = makeWardenHandler(new WardenService(warden), new DelegationStore(warden), new EvidenceService(warden, cfg), undefined, sovId.did, undefined, undefined, challenges);
  const wardenTransport = new DidCommTransport(warden, wardenId.name, config.nodeUrl);
  await wardenTransport.ready();
  const stopWarden = await wardenTransport.serve(handler, { pollMs: 1000 });

  const emiTransport = new DidCommTransport(emissary, emiId.name, config.nodeUrl);
  await emiTransport.ready();

  try {
    const reply = await invokeEvidence(emissary, emiTransport, wardenId.did, { claim: CLAIM, kind: 'location' });
    const granted = reply.type === 'hearthold/evidence-response' && reply.status === 'granted';
    check('invocation GRANTED — the Warden minted a signed evidence graph', granted, reply.type === 'hearthold/error' ? reply.reason : reply.type === 'hearthold/evidence-response' ? reply.reason ?? '' : '');
    if (!granted || reply.type !== 'hearthold/evidence-response') throw new Error('invocation did not grant');
    const schemaDid = reply.schemaDid ?? '';
    await acceptCredential(emissary, reply.credentialDid ?? ''); // the Emissary now holds the proof

    line('\n════ 4. VERIFY — a third party checks the proof ════');
    const challenge = await requestProof(verifier, { schema: schemaDid, trustedIssuers: [wardenId.did] });
    const presentation = await presentProof(emissary, challenge);
    const result = await verifyProof(verifier, presentation, { trustedIssuers: [wardenId.did], schema: schemaDid });
    check('the verifier VERIFIES the evidence graph (Warden-issued, held by the Emissary)', result.ok && result.responder === emiId.did, result.ok ? '' : result.reason ?? '');
    const claim = (result.disclosed[0]?.claims as { claim?: string } | undefined)?.claim;
    check('the disclosed claim is the proven fact', claim === CLAIM, `claim=${claim}`);
  } finally {
    await stopWarden();
  }

  line(`\n${failures === 0 ? '✅ SPINE COMPLETE — grant → invoke → proof, end to end' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
