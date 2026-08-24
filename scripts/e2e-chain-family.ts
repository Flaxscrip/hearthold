/**
 * e2e (Phase 5B, item 1): the KEYLESS family flow over HTTP + DIDComm. Two Emissary daemons (a delegator and a
 * delegate) + a served Warden. The Sovereign seeds a ROOT grant into the delegator; the delegator's Table POSTs
 * `delegate-capability` (mint attenuated child + transfer over DIDComm); the delegate receives + persists it and
 * POSTs `chain-invoke` → GRANTED; the delegator POSTs `revoke-hop` and the delegate's next invoke is DENIED.
 * This is the flow Aegis wires into the Pi family + agent-MCP.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-chain-family.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  DidCommTransport,
  Sensitivity,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { WardenService } from '@hearthold/warden/service';
import { EvidenceService } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';
import { ChallengeStore } from '@hearthold/warden/challenge-store';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { runEmissaryControl } from '@hearthold/emissary/control';
import { runSovereignControl } from '@hearthold/sovereign/control';

const A = 4370; // delegator daemon
const B = 4371; // delegate daemon
const SOV = 4372; // the governing Sovereign (agent-mode watch + co-sign)
const line = (m: string): void => process.stdout.write(`${m}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const unwrap = <T,>(r: { ok: boolean } & Record<string, unknown>): T => {
  if (!r.ok) throw new Error(String(r.error));
  const { ok: _ok, ...rest } = r;
  return rest as unknown as T;
};
const post = async <T,>(port: number, path: string, body: unknown): Promise<T> =>
  unwrap<T>((await (await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { ok: boolean } & Record<string, unknown>);
const get = async <T,>(port: number, path: string): Promise<T> =>
  unwrap<T>((await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as { ok: boolean } & Record<string, unknown>);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-chain-family-e2e';

  const warden = await openKeymaster('warden', base, pass);
  const sovereign = await openKeymaster('sovereign', base, pass);
  const delCfg = { ...base, dataRoot: `${base.dataRoot}/delegator` };
  const subCfg = { ...base, dataRoot: `${base.dataRoot}/delegate` };
  const delegator = await openKeymaster('emissary', delCfg, pass);
  const delegate = await openKeymaster('emissary', subCfg, pass);
  const wardenId = await ensureIdentity(warden, base);
  const sovId = await ensureIdentity(sovereign, base);
  const delId = await ensureIdentity(delegator, delCfg);
  const subId = await ensureIdentity(delegate, subCfg);
  const cfg = { ...base, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-fr', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  // Warden serves; the Sovereign watches + co-signs in AGENT mode; both Emissary daemons boot pointing at both.
  const challenges = new ChallengeStore(warden, base.registry, sovId.did);
  const handler = makeWardenHandler(new WardenService(warden), new DelegationStore(warden), new EvidenceService(warden, cfg), undefined, sovId.did, undefined, undefined, challenges);
  const wardenTransport = new DidCommTransport(warden, wardenId.name, base.nodeUrl);
  await wardenTransport.ready();
  const stopWarden = await wardenTransport.serve(handler, { pollMs: 1000 });
  await runSovereignControl(sovereign, { ...base, gateMode: 'agent', signetPin: undefined }, SOV);
  await runEmissaryControl(delegator, { ...delCfg, wardenDid: wardenId.did, sovereignDid: sovId.did }, A);
  await runEmissaryControl(delegate, { ...subCfg, wardenDid: wardenId.did, sovereignDid: sovId.did }, B);

  try {
    line(`\n════ the Sovereign seeds the delegator with a ROOT over DIDComm ════`);
    await post(SOV, '/api/mint-root', { emissaryDid: delId.did, ceiling: 'SEALED' });
    let seeded = false;
    for (let i = 0; i < 20 && !seeded; i++) {
      const h = await get<{ held: { leafVcDid: string }[] }>(A, '/api/held');
      seeded = (h.held?.length ?? 0) > 0;
      if (!seeded) await sleep(1000);
    }
    check('the delegator received + persisted its ROOT grant over DIDComm', seeded);

    line(`\n════ delegator holds a root; delegates onward to the delegate over DIDComm ════`);
    const del = await post<{ childVcDid: string }>(A, '/api/delegate-capability', { holderDid: subId.did, ceiling: Sensitivity.LOW, kinds: ['location'] });
    check('POST /api/delegate-capability → an attenuated child hop minted + transferred', !!del.childVcDid, del.childVcDid?.slice(0, 24));

    // Wait for the delegate daemon to receive + persist the transferred grant.
    let received = false;
    for (let i = 0; i < 20 && !received; i++) {
      const h = await get<{ held: { leafVcDid: string }[] }>(B, '/api/held');
      received = (h.held?.length ?? 0) > 0;
      if (!received) await sleep(1000);
    }
    check('the delegate received + persisted the chain grant over DIDComm', received);

    line('\n════ the delegate invokes its HELD chain (keyless, over HTTP → DIDComm) ════');
    const granted = await post<{ status: string; reason?: string; credentialDid?: string }>(B, '/api/chain-invoke', { claim: 'resided in FR', kind: 'location' });
    check('POST /api/chain-invoke → GRANTED with a credential', granted.status === 'granted' && !!granted.credentialDid, granted.reason ?? granted.status);

    line('\n════ ★ the delegator revokes its own delegated hop; the delegate is cut off ════');
    await post(A, '/api/revoke-hop', { childVcDid: del.childVcDid });
    const denied = await post<{ status: string; reason?: string }>(B, '/api/chain-invoke', { claim: 'resided in FR', kind: 'location' });
    check('★ POST /api/chain-invoke after revoke → DENIED (revoked)', denied.status === 'denied' && /revoked/.test(denied.reason ?? ''), denied.reason ?? denied.status);
  } finally {
    await stopWarden();
  }

  line(`\n${failures === 0 ? '✅ CHAIN FAMILY FLOW — delegate-capability → transfer → chain-invoke → revoke, all keyless over HTTP+DIDComm' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
