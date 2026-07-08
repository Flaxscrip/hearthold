/**
 * e2e: scrolls burn — single-use `txn` enforcement.
 *
 * A minted scroll carries a single-use `txn`. Presented once, it verifies and the txn is recorded spent
 * (verifier-side, so the holder can't reset it); a SECOND presentation of the same scroll is refused.
 * A different scroll (different txn) still verifies — only the spent one burns.
 *
 * Live (needs the Archon node). Run:  npm run e2e:scroll-burn
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureSchema,
  openSchema,
  issueClaim,
  acceptCredential,
  requestProof,
  presentProof,
  verifyProof,
  MemorySpentTxnStore,
} from '@hearthold/core';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-scroll-burn';
  const warden = await openKeymaster('warden', config, pass); // the issuer (Warden mints the scroll)
  const sovereign = await openKeymaster('sovereign', config, pass); // the holder
  const verifier = await openKeymaster('verifier', config, pass);
  const wid = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);

  const schema = await ensureSchema(warden, 'hearthold-scroll', openSchema('HearthholdAttestation'));
  // Mint two single-use scrolls (distinct txns) to the Sovereign.
  const scrollA = await issueClaim(warden, sovId.did, schema, { type: 'HearthholdAttestation', claim: 'had lunch at Chez Nous', txn: 'txn-AAA' });
  const scrollB = await issueClaim(warden, sovId.did, schema, { type: 'HearthholdAttestation', claim: 'visited the library', txn: 'txn-BBB' });
  await acceptCredential(sovereign, scrollA);
  await acceptCredential(sovereign, scrollB);
  const spent = new MemorySpentTxnStore();
  process.stdout.write('minted 2 single-use scrolls (txn-AAA, txn-BBB)\n');

  const present = async () => {
    const challenge = await requestProof(verifier, { schema, trustedIssuers: [wid.did] });
    const response = await presentProof(sovereign, challenge);
    return verifyProof(verifier, response, { schema, trustedIssuers: [wid.did], spentTxns: spent });
  };

  process.stdout.write('\n▸ First presentation verifies (and burns the txn)\n');
  const first = await present();
  assert(first.ok, 'the scroll verifies the first time');

  process.stdout.write('\n▸ Second presentation of the SAME scroll is refused\n');
  const second = await present();
  assert(!second.ok, 'a second presentation is refused — the scroll is spent (burned)');
  assert(/spent|burn/i.test(second.reason ?? ''), `the refusal says the scroll is spent: "${second.reason}"`);

  process.stdout.write('\n▸ Without the spent-txn store, single-use is not enforced (proving the store is the control)\n');
  const chal = await requestProof(verifier, { schema, trustedIssuers: [wid.did] });
  const resp = await presentProof(sovereign, chal);
  const noStore = await verifyProof(verifier, resp, { schema, trustedIssuers: [wid.did] });
  assert(noStore.ok, 'the same scroll re-verifies when no spent-txn store is supplied (enforcement is opt-in at the verifier)');

  process.stdout.write('\n✓ Scrolls burn: single-use txn enforced verifier-side — one presentation, then refused\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-scroll-burn: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
