/**
 * e2e: the invocation over REAL DIDComm, through `makeWardenHandler`'s dispatcher (audit-3 §7/§9).
 *
 * Every other invocation test calls `handleInvocation` directly with `fromDid` as a string literal, so the
 * transport authentication the whole holder binding rests on is never exercised. This one goes end-to-end: the
 * Emissary asks the Warden for a challenge over DIDComm, presents, and sends `hearthold/invocation` — the
 * Warden's authcrypt sender IS the `fromDid`. Then the captured presentation is replayed by a DIFFERENT sender,
 * and the Warden refuses it because the authcrypt sender ≠ the capability holder.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-didcomm.ts
 */
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureAuthorizationSchema,
  issueScopeCapability,
  acceptCredential,
  presentProof,
  DidCommTransport,
  PROTOCOL_VERSION,
  Sensitivity,
  type KeymasterHandle,
  type ChallengeResponseMessage,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { WardenService } from '@hearthold/warden/service';
import { EvidenceService } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';
import { ChallengeStore } from '@hearthold/warden/challenge-store';
import { makeWardenHandler } from '@hearthold/warden/handler';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-didcomm-e2e';
  const VAULT = 'hearthold:vault';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const attacker = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const emiId = await ensureIdentity(emissary, config);
  const atkId = await ensureIdentity(attacker, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-1', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  const scopeVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema, config,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
  });
  await acceptCredential(emissary, scopeVc);

  // The Warden serves the FULL handler over DIDComm (challenges wired → challenge-request + invocation).
  const challenges = new ChallengeStore(warden, config.registry, sovId.did);
  const handler = makeWardenHandler(new WardenService(warden), new DelegationStore(warden), new EvidenceService(warden, cfg), undefined, sovId.did, undefined, undefined, challenges);
  const wardenTransport = new DidCommTransport(warden, wardenId.name, config.nodeUrl);
  await wardenTransport.ready();
  const stopWarden = await wardenTransport.serve(handler, { pollMs: 1000 });

  const emiTransport = new DidCommTransport(emissary, emiId.name, config.nodeUrl);
  const atkTransport = new DidCommTransport(attacker, atkId.name, config.nodeUrl);
  await emiTransport.ready();
  await atkTransport.ready();

  const act = () => ({ action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: randomUUID(), args: { claim: 'resided in FR', spec: { kind: 'location' } } });

  // Fetch a fresh Warden-minted invocation challenge over DIDComm and answer it with the holder's wallet.
  const freshPresentation = async (client: KeymasterHandle, transport: DidCommTransport): Promise<string> => {
    const reply = await transport.request(wardenId.did, { type: 'hearthold/challenge-request', version: PROTOCOL_VERSION, purpose: 'invocation' }, { timeoutMs: 30_000 });
    if (reply.type !== 'hearthold/challenge-response') throw new Error(`challenge-request failed: ${JSON.stringify(reply)}`);
    return presentProof(client, (reply as ChallengeResponseMessage).challenge);
  };

  try {
    line('\n════ invocation over DIDComm (dispatcher + authcrypt) ════');

    // Honest: the Emissary presents + invokes; the Warden's authcrypt sender is the Emissary.
    const presentation = await freshPresentation(emissary, emiTransport);
    const granted = await emiTransport.request(wardenId.did, { type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation, act: act() }, { timeoutMs: 30_000 });
    check('Emissary invocation over DIDComm → GRANTED', granted.type === 'hearthold/evidence-response' && (granted as { status?: string }).status === 'granted', (granted as { reason?: string }).reason ?? granted.type);

    // Attack: the attacker captures a fresh Emissary presentation and sends it under ITS OWN authcrypt identity.
    // The Warden's fromDid is the attacker, ≠ the capability holder → refused (the binding the design rests on).
    const captured = await freshPresentation(emissary, emiTransport);
    const replayed = await atkTransport.request(wardenId.did, { type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation: captured, act: act() }, { timeoutMs: 30_000 });
    const denied = (replayed as { status?: string }).status === 'denied' || replayed.type === 'hearthold/error';
    check('captured presentation replayed by a different authcrypt sender → DENIED', denied, (replayed as { reason?: string }).reason ?? replayed.type);
  } finally {
    await stopWarden();
  }

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
