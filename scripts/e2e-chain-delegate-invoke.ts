/**
 * e2e (Phase 5B, item 1): the holder-side multi-hop gestures over REAL DIDComm. The Sovereign mints a root held
 * by the Emissary; the Emissary DELEGATES an attenuated, revocable child ONWARD to a sub-agent; the sub-agent
 * presents the held chain to the Warden over DIDComm and gets evidence; then the EMISSARY revokes ITS OWN
 * delegated hop and the sub-agent is denied at the next invocation — a delegator's kill-switch over its child.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-chain-delegate-invoke.ts
 */
import { randomUUID } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  mintRootCapability,
  ensureCapabilityStatusContext,
  allocateIndex,
  revokeStatusIndex,
  STATUS_LIST_LENGTH,
  DidCommTransport,
  Sensitivity,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { WardenService } from '@hearthold/warden/service';
import { EvidenceService } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';
import { ChallengeStore } from '@hearthold/warden/challenge-store';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { delegateOnward, chainInvokeEvidence, type ChainCapabilityGrant } from '@hearthold/emissary/chain';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-chain-delegate-e2e';
  const reg = config.registry;
  const VAULT = 'hearthold:vault';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const subagent = await openKeymaster('verifier', config, pass); // the third-party sub-agent (leaf holder)
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const emiId = await ensureIdentity(emissary, config);
  const subId = await ensureIdentity(subagent, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-fr', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  // Sovereign mints a ROOT held by the Emissary (status in the Sovereign's list).
  const sovStatus = await ensureCapabilityStatusContext(sovereign, sovId.name, config);
  const rootIdx = (await allocateIndex(sovereign, sovId.name, sovStatus.allocationRecord, randomUUID(), STATUS_LIST_LENGTH)).index;
  const root = await mintRootCapability({
    issuer: sovereign,
    issuerName: sovId.name,
    holder: emiId.did,
    capability: {
      invocationTarget: VAULT,
      authority: { operations: ['prove', 'submit'], resources: [VAULT] },
      caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did, status: { statusListCredential: sovStatus.statusListCredential, statusListIndex: rootIdx } },
    },
    registry: reg,
  });
  const emissaryGrant: ChainCapabilityGrant = { handle: root, ancestorDisclosures: {} };

  // Emissary delegates an attenuated child ONWARD to the sub-agent (prove-only, LOW, location).
  const { grant: subGrant, issued } = await delegateOnward({
    issuer: emissary,
    issuerName: emiId.name,
    config,
    parent: emissaryGrant,
    holderDid: subId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.LOW, owner: sovId.did, kinds: ['location'] } },
  });
  line(`\nchain: Sovereign → Emissary(holds root) → sub-agent(holds child, counter ${subGrant.handle.issued.counter})`);
  check('Emissary delegated an attenuated, revocable child hop onward', subGrant.handle.issued.counter === 1 && !!issued.statusListCredential);

  // Warden serves over DIDComm.
  const challenges = new ChallengeStore(warden, config.registry, sovId.did);
  const handler = makeWardenHandler(new WardenService(warden), new DelegationStore(warden), new EvidenceService(warden, cfg), undefined, sovId.did, undefined, undefined, challenges);
  const wardenTransport = new DidCommTransport(warden, wardenId.name, config.nodeUrl);
  await wardenTransport.ready();
  const stopWarden = await wardenTransport.serve(handler, { pollMs: 1000 });
  const subTransport = new DidCommTransport(subagent, subId.name, config.nodeUrl);
  await subTransport.ready();

  try {
    line('\n════ the sub-agent presents its HELD chain over DIDComm ════');
    const a = await chainInvokeEvidence(subagent, subId.name, subTransport, wardenId.did, subGrant, { claim: 'resided in FR', kind: 'location' });
    check('GRANTED — delegated chain invoked over real DIDComm', a.type === 'hearthold/evidence-response' && a.status === 'granted', a.type === 'hearthold/error' ? a.reason : a.type === 'hearthold/evidence-response' ? a.reason ?? '' : '');

    line('\n════ ★ the EMISSARY revokes ITS OWN delegated hop ════');
    await revokeStatusIndex(emissary, emiId.name, issued.statusListCredential, issued.statusListIndex);
    const b = await chainInvokeEvidence(subagent, subId.name, subTransport, wardenId.did, subGrant, { claim: 'resided in FR', kind: 'location' });
    const denied = b.type === 'hearthold/error' || (b.type === 'hearthold/evidence-response' && b.status === 'denied');
    const reason = b.type === 'hearthold/evidence-response' && b.status === 'denied' ? b.reason : b.type === 'hearthold/error' ? b.reason : '';
    check('★ DENIED — a delegator revoking its own child hop kills the sub-agent at next invocation', denied && /revoked/.test(reason ?? ''), reason ?? '');
  } finally {
    await stopWarden();
  }

  line(`\n${failures === 0 ? '✅ CHAIN DELEGATE + INVOKE over DIDComm — delegate onward, invoke, revoke-own-hop deny' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
