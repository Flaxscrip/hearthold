/**
 * Seed a data root for the evidence step-up smoke: provision warden/witness/sovereign, delegate the
 * Witness, and store some MEDIUM 'location' observations. Prints the DIDs the daemons + requester use.
 *
 * Passphrases (throwaway): warden=demo-warden, sovereign=demo-sov, witness=demo-witness.
 * Run:  HEARTHOLD_DATA_ROOT=... node --experimental-strip-types scripts/seed-evidence-demo.ts
 */
import { createHash } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  Sensitivity,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { DelegationStore } from '@hearthold/warden/delegations';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');

async function main(): Promise<void> {
  const config = loadConfig();
  const warden = await openKeymaster('warden', config, 'demo-warden');
  const witness = await openKeymaster('witness', config, 'demo-witness');
  const sovereign = await openKeymaster('sovereign', config, 'demo-sov');
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  const sovId = await ensureIdentity(sovereign, config);

  const schema = await ensureDelegationSchema(warden);
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const cred = await issueDelegation(warden, witnessId.did, schema, { kinds: ['location'], validUntil: oneYear });
  await new DelegationStore(warden).record(witnessId.did, cred);

  const store = new VaultStore(warden.dataFolder);
  for (const [i, day] of ['2026-02-04', '2026-03-11', '2026-04-20'].entries()) {
    await store.put({
      id: hex(`loc-${i}`),
      kind: 'location',
      observedAt: `${day}T09:00:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.MEDIUM,
      ciphertext: '(sealed)',
      metadata: { witness: witnessId.did },
    });
  }

  process.stdout.write(`WARDEN_DID=${wardenId.did}\n`);
  process.stdout.write(`SOVEREIGN_DID=${sovId.did}\n`);
  process.stdout.write(`WITNESS_DID=${witnessId.did}\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`seed-evidence-demo: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
