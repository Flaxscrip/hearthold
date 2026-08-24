/**
 * e2e: THE SPEND RECEIPTS FEED — the Warden's passive observation log the Table renders (Aegis + Sevenfold).
 *
 * The converged contract: `SpendReceipt { agent, amount, unit?, purpose, band, approver, approved, paid,
 * reason?, at, paymentHash?, sensitivityName? }` with the fail-closed invariant **`!approved ⇒ !paid`**,
 * served over `GET /api/spend/receipts`. This proves the store round-trips it, enforces the invariant, and
 * that the Warden control daemon wires the route. Pure filesystem — no node needed.
 *
 *   node --experimental-strip-types scripts/e2e-spend-receipts.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpendReceiptStore } from '@hearthold/warden/spend-receipt-store';
import type { SpendReceipt } from '@hearthold/control-types';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hearthold-spend-receipts-'));
  try {
    const store = new SpendReceiptStore(dir);

    step('round-trip — the feed accumulates receipts, most-recent-first');
    const settled: SpendReceipt = { agent: 'did:cid:agentA', amount: 2500, unit: 'sat', purpose: 'premium data', band: 'agent', approver: 'self-notify', approved: true, paid: true, at: '2026-08-01T10:00:00Z', paymentHash: 'abc123' };
    const held: SpendReceipt = { agent: 'did:cid:agentA', amount: 20000, unit: 'sat', purpose: 'big buy', band: 'parent', approver: 'did:cid:parent', approved: false, paid: false, reason: 'declined', at: '2026-08-01T10:05:00Z' };
    const standing: SpendReceipt = { agent: 'did:cid:agentB', amount: 50, unit: 'sat', purpose: 'tiny', band: 'standing', approver: 'standing', approved: true, paid: true, at: '2026-08-01T10:10:00Z' };
    await store.record(settled);
    await store.record(held);
    await store.record(standing);
    const list = await store.list();
    check('all three receipts are present', list.length === 3);
    check('most-recent-first ordering', list[0]?.at === standing.at && list[2]?.at === settled.at);
    check('a settled receipt reads agent · amount · unit · paid · paymentHash', list[2]?.paid === true && list[2]?.paymentHash === 'abc123' && list[2]?.amount === 2500);
    check('a held (declined) receipt carries reason + paid:false', list[1]?.approved === false && list[1]?.paid === false && list[1]?.reason === 'declined');

    step('the fail-closed invariant is ENFORCED — a denied receipt can never be marked paid');
    // Even if a buggy caller passes approved:false with paid:true, the store forces paid:false.
    await store.record({ agent: 'did:cid:agentA', amount: 999, unit: 'sat', purpose: 'sneaky', band: 'parent', approver: 'did:cid:parent', approved: false, paid: true, at: '2026-08-01T10:15:00Z' });
    const after = await store.list();
    check('a denied-but-paid receipt is coerced to paid:false (funds never moved)', after[0]?.approved === false && after[0]?.paid === false);

    step('the list is capped (the passive feed never grows unbounded on the wire)');
    for (let i = 0; i < 130; i++) await store.record({ agent: 'did:cid:agentA', amount: i, unit: 'sat', purpose: `n${i}`, band: 'agent', approver: 'self-notify', approved: true, paid: true, at: `2026-08-02T00:00:${String(i).padStart(2, '0')}Z` });
    check('list(default) caps at 100', (await store.list()).length === 100);
    check('list(5) honours an explicit limit', (await store.list(5)).length === 5);

    step('source-scan — the Warden control daemon wires the feed');
    const control = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/warden/src/control.ts'), 'utf8');
    check("GET /api/spend/receipts is served", /'GET \/api\/spend\/receipts'/.test(control) && /spendReceipts\.list\(\)/.test(control));
    check('the store is constructed from the data root', /new SpendReceiptStore\(handle\.dataFolder\)/.test(control));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ spend-receipts: the feed round-trips the converged SpendReceipt, enforces !approved⇒!paid, caps the list, and is served at GET /api/spend/receipts\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-spend-receipts: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
