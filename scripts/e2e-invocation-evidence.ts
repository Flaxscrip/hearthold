/**
 * e2e (Phase 2b): the evidence path rebuilt on capabilities — live against Archon.
 *
 * A vault holds two owners' location artefacts. The Emissary presents a CAPABILITY (root→delegated, owner =
 * the Sovereign) and invokes `prove`. The Warden:
 *   - authorizes by the capability at the point of use (verifyInvocation), not a requester-supplied subjectDid;
 *   - assembles evidence scoped to the capability's OWNER — so the other owner's artefact never enters the
 *     graph (the whole-vault store.list() leak is closed);
 *   - binds the scroll to the holder, not a requester-chosen recipient.
 * The legacy `handle()` path is proven untouched (still grants; still whole-vault) — back-compat behind the
 * capability check. Run:  HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 \
 *                          HEARTHOLD_REGISTRY=local node --experimental-strip-types scripts/e2e-invocation-evidence.ts
 */
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  mintRootCapability,
  delegateCapability,
  discloseChain,
  AUTHORIZATION_TYPE,
  PROTOCOL_VERSION,
  Sensitivity,
  type CapabilityHandle,
  type CapabilityInvocation,
  type EvidenceRequest,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService } from '@hearthold/warden/evidence';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const cred = (h: CapabilityHandle): CapabilityInvocation['capability'] => ({
  type: ['VerifiableCredential', AUTHORIZATION_TYPE],
  credentialSubject: h.capability,
});

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-evidence-e2e';
  const reg = config.registry;
  const VAULT = 'hearthold:vault';

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const other = await openKeymaster('verifier', config, pass); // stands in for a second household member
  await ensureIdentity(warden, config);
  const emiId = await ensureIdentity(emissary, config);
  const sovId = await ensureIdentity(sovereign, config);
  const otherId = await ensureIdentity(other, config);
  // The Warden's evidence path attributes pre-family / default data to config.sovereignDid.
  const cfg = { ...config, sovereignDid: sovId.did };

  // Seed the vault: ONE location artefact per owner (the Sovereign's, and another member's).
  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-sov', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });
  await store.put({ id: 'art-other', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'y', metadata: { witness: 'device-B' }, owner: otherId.did });

  const evidence = new EvidenceService(warden, cfg);

  line(`\n════ Sovereign root over ${VAULT} → Emissary delegation (prove ≤ MEDIUM, owner = Sovereign) ════`);
  const root = await mintRootCapability({
    issuer: sovereign, issuerName: sovId.name, holder: sovId.did,
    capability: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
    registry: reg,
  });
  const emi = await delegateCapability({
    issuer: sovereign, issuerName: sovId.name, parent: root, holder: emiId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
    registry: reg,
  });

  const invocation = (txn: string): CapabilityInvocation => ({
    type: 'hearthold/invocation', version: PROTOCOL_VERSION, capability: cred(emi),
    act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn, args: { claim: 'resided in FR', spec: { kind: 'location' } } },
    disclosed: discloseChain(emi, root), orderedCaveats: [emi.capability.caveats, root.capability.caveats],
  });

  line('\n════ the capability path ════');
  const granted = await evidence.handleInvocation(invocation(randomUUID()), emiId.did);
  check('capability invocation GRANTED', granted.status === 'granted', granted.reason ?? '');
  check('OWNER-SCOPED: only the subject’s artefact enters the graph (count = 1, not the whole vault)', granted.graph?.evidence?.[0]?.count === 1, `count=${granted.graph?.evidence?.[0]?.count}`);

  const wrongHolder = await evidence.handleInvocation(invocation(randomUUID()), otherId.did);
  check('a NON-HOLDER invocation is DENIED (holder binding, not a request field)', wrongHolder.status === 'denied' && /holder/.test(wrongHolder.reason ?? ''), wrongHolder.reason ?? '');

  line('\n════ the legacy path is untouched (back-compat) ════');
  const legacyReq: EvidenceRequest = { type: 'hearthold/evidence-request', version: PROTOCOL_VERSION, claim: 'resided in FR', disclosureMode: 'ATTESTATION', spec: { kind: 'location' } };
  const legacy = await evidence.handle(legacyReq, emiId.did, true);
  check('legacy handle() still GRANTS at STANDING', legacy.status === 'granted', legacy.reason ?? '');
  check('legacy handle() is UNSCOPED (whole vault, count = 2) — the behavior kept behind the capability check', legacy.graph?.evidence?.[0]?.count === 2, `count=${legacy.graph?.evidence?.[0]?.count}`);

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
