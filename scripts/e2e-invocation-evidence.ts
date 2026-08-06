/**
 * e2e (Phase 2b, VC edition): the evidence path on capabilities-as-VCs — live against Archon.
 *
 * The Sovereign issues the Emissary a scope-capability VC; the Emissary invokes by PRESENTING it in response
 * to the Warden's credential-requesting challenge (Archon `verifyResponse`). The Warden authorizes against the
 * VERIFIED scope (issuer-trusted + holder-controlled) — never a wire body — assembles owner-scoped, and binds
 * the scroll to the verified holder. The legacy `handle()` path is proven untouched (back-compat). Run:
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-evidence.ts
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

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-evidence-e2e';
  const reg = config.registry;
  const VAULT = 'hearthold:vault';

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const other = await openKeymaster('verifier', config, pass); // a second household member
  const wardenId = await ensureIdentity(warden, config);
  const emiId = await ensureIdentity(emissary, config);
  const sovId = await ensureIdentity(sovereign, config);
  const otherId = await ensureIdentity(other, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  // Seed the vault: ONE location artefact per owner.
  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-sov', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });
  await store.put({ id: 'art-other', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'y', metadata: { witness: 'device-B' }, owner: otherId.did });

  line(`\n════ Sovereign issues a scope-capability VC to the Emissary (prove ≤ MEDIUM, owner = Sovereign) ════`);
  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  const scopeVc = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
  });
  await acceptCredential(emissary, scopeVc);

  // The invocation ceremony: the Warden requests the scope credential; the Emissary presents it.
  const present = async (): Promise<string> => {
    const challenge = await requestProof(warden, { schema: authSchema, trustedIssuers: [sovId.did] });
    return presentProof(emissary, challenge);
  };
  const invocation = async (txn: string): Promise<CapabilityInvocation> => ({
    type: 'hearthold/invocation', version: PROTOCOL_VERSION, presentation: await present(),
    act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn, args: { claim: 'resided in FR', spec: { kind: 'location' } } },
  });

  const evidence = new EvidenceService(warden, cfg);

  line('\n════ the capability path ════');
  const granted = await evidence.handleInvocation(await invocation(randomUUID()), emiId.did);
  check('capability invocation GRANTED', granted.status === 'granted', granted.reason ?? '');
  check('OWNER-SCOPED: only the subject’s artefact enters the graph (count = 1, not the whole vault)', granted.graph?.evidence?.[0]?.count === 1, `count=${granted.graph?.evidence?.[0]?.count}`);

  const wrongHolder = await evidence.handleInvocation(await invocation(randomUUID()), otherId.did);
  check('a NON-HOLDER caller is DENIED (holder binding, not a request field)', wrongHolder.status === 'denied' && /holder/.test(wrongHolder.reason ?? ''), wrongHolder.reason ?? '');

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
