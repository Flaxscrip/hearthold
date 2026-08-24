/**
 * e2e (Phase 5B, item 5): the WATCH backend. The Sovereign governs a live delegation forest — it mints a root,
 * an agent's Emissary delegates onward, and the Sovereign's lineage view reflects the tree (who → whom, depth,
 * revoked state) fed by the Emissaries' hop reports. It can also independently VERIFY a leaf by walking the
 * PUBLIC chain (zero decryption). Then a revoke shows up in the watch. No Warden needed — this is delegation +
 * governance, not invocation.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-watch-lineage.ts
 */
import { loadConfig, openKeymaster, ensureIdentity } from '@hearthold/core';
import { runSovereignControl } from '@hearthold/sovereign/control';
import { runEmissaryControl } from '@hearthold/emissary/control';

const SOV = 4380;
const A = 4381; // delegator Emissary
const B = 4382; // delegate Emissary
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

interface TreeNode { vcDid: string; holder: string; counter: number; revoked?: boolean; children: TreeNode[] }

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-watch-lineage-e2e';

  const sovereign = await openKeymaster('sovereign', base, pass);
  const delCfg = { ...base, dataRoot: `${base.dataRoot}/delegator` };
  const subCfg = { ...base, dataRoot: `${base.dataRoot}/delegate` };
  const delegator = await openKeymaster('emissary', delCfg, pass);
  const delegate = await openKeymaster('emissary', subCfg, pass);
  const sovId = await ensureIdentity(sovereign, base);
  const delId = await ensureIdentity(delegator, delCfg);
  const subId = await ensureIdentity(delegate, subCfg);

  // The Sovereign watches in AGENT mode (self-approves mint-root, no PIN). Both Emissaries report to it.
  await runSovereignControl(sovereign, { ...base, gateMode: 'agent', signetPin: undefined }, SOV);
  await runEmissaryControl(delegator, { ...delCfg, sovereignDid: sovId.did }, A);
  await runEmissaryControl(delegate, { ...subCfg, sovereignDid: sovId.did }, B);

  try {
    line('\n════ the Sovereign mints a ROOT for the delegator (recorded in the watch) ════');
    const minted = await post<{ minted?: boolean; rootVcDid?: string }>(SOV, '/api/mint-root', { emissaryDid: delId.did, ceiling: 'LOW', kinds: ['location'] });
    check('mint-root → the family root of authority is created + recorded', minted.minted === true && !!minted.rootVcDid, minted.rootVcDid?.slice(0, 20));
    const rootVcDid = minted.rootVcDid!;

    // Wait for the delegator to receive the root over DIDComm.
    let seeded = false;
    for (let i = 0; i < 20 && !seeded; i++) {
      const h = await get<{ held: unknown[] }>(A, '/api/held');
      seeded = (h.held?.length ?? 0) > 0;
      if (!seeded) await sleep(1000);
    }
    check('the delegator holds the root', seeded);

    line('\n════ the delegator delegates onward — the hop reports to the Sovereign\'s watch ════');
    const del = await post<{ childVcDid: string }>(A, '/api/delegate-capability', { holderDid: subId.did, ceiling: 1, kinds: ['location'] });
    const childVcDid = del.childVcDid;

    // Poll the Sovereign's lineage until the child hop appears under the root.
    let childNode: TreeNode | undefined;
    let root: TreeNode | undefined;
    for (let i = 0; i < 20 && !childNode; i++) {
      const { forest } = await get<{ forest: TreeNode[] }>(SOV, '/api/lineage');
      root = forest.find((r) => r.vcDid === rootVcDid);
      childNode = root?.children.find((c) => c.vcDid === childVcDid);
      if (!childNode) await sleep(1000);
    }
    check('the WATCH shows the delegation forest: root → child (holder = the delegate)', !!root && !!childNode && childNode!.holder === subId.did && childNode!.counter === 1, childNode ? `counter ${childNode.counter}` : 'child not in forest');

    line('\n════ the Sovereign VERIFIES the leaf against the public chain (zero decryption) ════');
    const { lineage } = await post<{ lineage: { vcDid: string; counter: number }[] }>(SOV, '/api/reconstruct-lineage', { leafVcDid: childVcDid });
    check('reconstruct-lineage walks the public chain root → leaf', lineage.length === 2 && lineage[0]?.counter === 0 && lineage[0]?.vcDid === rootVcDid && lineage[1]?.vcDid === childVcDid, `${lineage.length} hops`);

    line('\n════ ★ the delegator revokes the hop — the watch reflects it ════');
    await post(A, '/api/revoke-hop', { childVcDid });
    let revoked = false;
    for (let i = 0; i < 20 && !revoked; i++) {
      const { forest } = await get<{ forest: TreeNode[] }>(SOV, '/api/lineage');
      const c = forest.find((r) => r.vcDid === rootVcDid)?.children.find((x) => x.vcDid === childVcDid);
      revoked = c?.revoked === true;
      if (!revoked) await sleep(1000);
    }
    check('★ the WATCH marks the hop revoked after the delegator cuts it', revoked);
  } finally {
    // daemons end on process.exit
  }

  line(`\n${failures === 0 ? '✅ WATCH BACKEND — the Sovereign governs a live delegation forest (mint → delegate → verify → revoke)' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
