/**
 * e2e (audit-5): the authority-mutating write routes are CO-SIGN GATED. `delegate-capability` (and `revoke-hop`)
 * no longer run on a bare unauthenticated POST — they require the governing Sovereign's co-sign first. Here we
 * boot an Emissary with NO governing Sovereign and confirm the delegation is REFUSED (fail-closed), not silently
 * granting a slice of family authority. The approve path is covered live by watch-lineage / watch-flow / chain-family.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-write-cosign.ts
 */
import { loadConfig, openKeymaster, ensureIdentity } from '@hearthold/core';
import { runEmissaryControl } from '@hearthold/emissary/control';

const PORT = 4396;
const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const post = async (path: string, body: unknown): Promise<{ ok: boolean } & Record<string, unknown>> =>
  (await (await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { ok: boolean } & Record<string, unknown>;

async function main(): Promise<void> {
  const base = loadConfig();
  const emissary = await openKeymaster('emissary', base, 'hearthold-write-cosign-e2e');
  await ensureIdentity(emissary, base);
  // Boot the Emissary daemon with NO governing Sovereign configured.
  await runEmissaryControl(emissary, { ...base, sovereignDid: undefined }, PORT);

  line('\n════ an authority-mutating write with no governor to co-sign ════');
  const r = await post('/api/delegate-capability', { holderDid: 'did:cid:bagaaieranobodyinparticular' });
  check('delegate-capability is REFUSED (fail-closed) with no governing Sovereign to co-sign', r.ok === false && /governing Sovereign/i.test(String(r.error)), String(r.error));

  const rv = await post('/api/revoke-hop', { childVcDid: 'did:cid:bagaaieranohop' });
  check('revoke-hop is REFUSED (fail-closed) with no governing Sovereign to co-sign', rv.ok === false && /governing Sovereign/i.test(String(rv.error)), String(rv.error));

  line(`\n${failures === 0 ? '✅ WRITE CO-SIGN — the authority-mutating routes fail closed without a governor to approve' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
