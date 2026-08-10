/**
 * e2e (Phase 5B, item 1): AgentGate mode for `sovereign control`. An AI-agent Sovereign exposes the HTTP surface
 * (for the agent-MCP / Table) but SELF-APPROVES within-scope acts — no human PIN — keeping standing autonomy.
 * We boot the control daemon with `gateMode: 'agent'` (no PIN configured) and confirm mint-root +
 * authorize-capability go through without a human, each leaving a proof-of-AGENT receipt.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-agent-gate.ts
 */
import { loadConfig, openKeymaster, ensureIdentity, DidCommTransport } from '@hearthold/core';
import { runSovereignControl } from '@hearthold/sovereign/control';

const PORT = 4372;
const line = (m: string): void => process.stdout.write(`${m}\n`);
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
const post = async <T,>(path: string, body: unknown): Promise<T> =>
  unwrap<T>((await (await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { ok: boolean } & Record<string, unknown>);
const get = async <T,>(path: string): Promise<T> =>
  unwrap<T>((await (await fetch(`http://127.0.0.1:${PORT}${path}`)).json()) as { ok: boolean } & Record<string, unknown>);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-agent-gate-e2e';

  const sovereign = await openKeymaster('sovereign', base, pass);
  const emissary = await openKeymaster('emissary', { ...base, dataRoot: `${base.dataRoot}/emissary` }, pass);
  const sovId = await ensureIdentity(sovereign, base);
  const emiId = await ensureIdentity(emissary, { ...base, dataRoot: `${base.dataRoot}/emissary` });
  // Publish the Emissary's DIDComm endpoint so the mint-root chain-grant hand-off can be delivered.
  const emiTransport = new DidCommTransport(emissary, 'hearthold-emissary', base.nodeUrl);
  await emiTransport.ready();

  // Boot the Sovereign control daemon in AGENT mode — NO signetPin. If the guard were wrong this would throw.
  await runSovereignControl(sovereign, { ...base, gateMode: 'agent', signetPin: undefined }, PORT);
  line(`agent-mode Signet control up (no PIN); agent DID ${sovId.did.slice(0, 24)}…`);

  try {
    line('\n════ the AI-agent Sovereign self-approves within scope (no human PIN) ════');
    const minted = await post<{ minted?: boolean; declined?: boolean; rootVcDid?: string }>('/api/mint-root', { emissaryDid: emiId.did, ceiling: 'LOW', kinds: ['location'] });
    check('POST /api/mint-root → self-approved + minted (no PIN)', minted.minted === true && !!minted.rootVcDid, minted.declined ? 'declined' : (minted.rootVcDid?.slice(0, 20) ?? ''));

    const granted = await post<{ granted?: boolean; credentialDid?: string }>('/api/authorize-capability', { emissaryDid: emiId.did, ceiling: 'LOW', kinds: ['location'] });
    check('POST /api/authorize-capability → self-approved + granted (no PIN)', granted.granted === true && !!granted.credentialDid, granted.credentialDid?.slice(0, 20) ?? '');

    line('\n════ the self-approvals leave a proof-of-AGENT receipt trail ════');
    const snap = await get<{ pending: unknown[]; history: { method?: string; decision: string }[] }>('/api/snapshot');
    check('nothing is left pending (agent self-approves synchronously)', (snap.pending?.length ?? -1) === 0, `pending=${snap.pending?.length}`);
    const agentApprovals = (snap.history ?? []).filter((h) => h.method === 'agent' && h.decision === 'approved').length;
    check('the receipt history records the agent self-approvals', agentApprovals >= 2, `agent-approved=${agentApprovals}`);
  } finally {
    // no explicit stop handle from runSovereignControl; process.exit ends the daemon.
  }

  line(`\n${failures === 0 ? '✅ AGENT-GATE CONTROL — an AI-agent Sovereign self-approves within scope, no PIN, receipts' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
