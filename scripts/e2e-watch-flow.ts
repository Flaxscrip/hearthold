/**
 * e2e (Phase 5B, item 5 Slice B): the A2A FLOW watch — "watch the encrypted messages pass". The full family:
 * a served Warden, a Sovereign that watches, and two Emissary daemons. The Sovereign mints a root → the
 * delegator delegates onward → the delegate chain-invokes → and the Sovereign's flow log shows the disclosure
 * PASS under authority (who → whom, which capability, granted) — never the disclosed content. Monitoring, not
 * surveillance.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-watch-flow.ts
 */
import { loadConfig, openKeymaster, ensureIdentity, DidCommTransport, Sensitivity } from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { WardenService } from '@hearthold/warden/service';
import { EvidenceService } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';
import { ChallengeStore } from '@hearthold/warden/challenge-store';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { runSovereignControl } from '@hearthold/sovereign/control';
import { runEmissaryControl } from '@hearthold/emissary/control';

const SOV = 4390;
const A = 4391;
const B = 4392;
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

interface Flow { from: string; to: string; kind: string; governingCapabilityDid?: string; witnessKind?: string; decision?: string }

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-watch-flow-e2e';

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

  // Warden serves; the Sovereign watches (agent mode); both Emissaries report to it.
  const challenges = new ChallengeStore(warden, base.registry, sovId.did);
  const handler = makeWardenHandler(new WardenService(warden), new DelegationStore(warden), new EvidenceService(warden, cfg), undefined, sovId.did, undefined, undefined, challenges);
  const wardenTransport = new DidCommTransport(warden, wardenId.name, base.nodeUrl);
  await wardenTransport.ready();
  const stopWarden = await wardenTransport.serve(handler, { pollMs: 1000 });
  await runSovereignControl(sovereign, { ...base, gateMode: 'agent', signetPin: undefined }, SOV);
  await runEmissaryControl(delegator, { ...delCfg, wardenDid: wardenId.did, sovereignDid: sovId.did }, A);
  await runEmissaryControl(delegate, { ...subCfg, wardenDid: wardenId.did, sovereignDid: sovId.did }, B);

  try {
    line('\n════ seed a root → delegate onward → the delegate chain-invokes ════');
    await post(SOV, '/api/mint-root', { emissaryDid: delId.did, ceiling: 'LOW', kinds: ['location'] });
    for (let i = 0; i < 20; i++) { if (((await get<{ held: unknown[] }>(A, '/api/held')).held?.length ?? 0) > 0) break; await sleep(1000); }
    const del = await post<{ childVcDid: string }>(A, '/api/delegate-capability', { holderDid: subId.did, ceiling: 1, kinds: ['location'] });
    for (let i = 0; i < 20; i++) { if (((await get<{ held: unknown[] }>(B, '/api/held')).held?.length ?? 0) > 0) break; await sleep(1000); }
    const inv = await post<{ status: string }>(B, '/api/chain-invoke', { claim: 'resided in FR', kind: 'location' });
    check('the delegate chain-invokes — GRANTED', inv.status === 'granted', inv.status);

    line('\n════ ★ the Sovereign WATCHES the flow (envelope + authority + outcome, no content) ════');
    let flow: Flow | undefined;
    for (let i = 0; i < 20 && !flow; i++) {
      const { flow: log } = await get<{ flow: Flow[] }>(SOV, '/api/flow');
      flow = log.find((f) => f.kind === 'chain-invocation' && f.from === subId.did);
      if (!flow) await sleep(1000);
    }
    check('the flow log shows the delegate\'s chain-invocation under the governing capability', !!flow && flow!.governingCapabilityDid === del.childVcDid && flow!.witnessKind === 'location' && flow!.decision === 'granted', flow ? `${flow.kind} ${flow.decision}` : 'no flow event');
    check('the flow event carries NO disclosed content — only who/whom/kind/decision', !!flow && !('claim' in (flow as object)) && !('graph' in (flow as object)));
  } finally {
    await stopWarden();
  }

  line(`\n${failures === 0 ? '✅ FLOW WATCH — the Sovereign sees each capability exercised across the family, without the content' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
