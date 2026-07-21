/**
 * e2e: financial evidence graph (A1, financial theme).
 *
 * Financial variant of e2e-evidence.ts. Seeds the Warden's vault with quarterly income
 * observations and has the Warden assemble + mint a signed evidence graph attesting a
 * DERIVED threshold fact — "annual income exceeds the $200,000 accredited-investor
 * threshold" — which a verifier verifies while learning the fact and that supporting
 * records exist (count + Merkle root), never the underlying figures.
 *
 * Isolated data root; run:  npm run e2e:finance-evidence
 */
import { createHash } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  acceptCredential,
  requestProof,
  presentProof,
  verifyProof,
  Sensitivity,
  PROTOCOL_VERSION,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-finance-evidence';

  const warden = await openKeymaster('warden', config, pass);
  const witness = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);

  // 1. Warden delegates the Emissary to submit income 'transaction' observations.
  const delSchema = await ensureDelegationSchema(warden);
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const delCred = await issueDelegation(warden, witnessId.did, delSchema, {
    kinds: ['transaction'],
    validUntil: oneYear,
  });
  await new DelegationStore(warden).record(witnessId.did, delCred);

  // 2. Seed the vault with four quarterly income records (LOW → STANDING clears; the
  //    actual figures live in the sealed ciphertext, never disclosed).
  const store = new VaultStore(warden.dataFolder);
  const quarters = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'];
  for (const [i, day] of quarters.entries()) {
    await store.put({
      id: hex(`income-q${i + 1}`),
      kind: 'transaction',
      observedAt: `${day}T00:00:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.LOW,
      ciphertext: '(sealed)',
      metadata: { witness: witnessId.did },
    });
  }
  process.stdout.write(`seeded ${quarters.length} income transaction records\n`);

  // 3. Relying party requests proof of the threshold → Warden assembles + mints the graph.
  const evidence = new EvidenceService(warden, { ...config, sovereignDid: sovId.did });
  const delegationValid = await new DelegationStore(warden).isAuthorized(witnessId.did);
  const resp = await evidence.handle(
    {
      type: 'hearthold/evidence-request',
      version: PROTOCOL_VERSION,
      claim: 'Annual income exceeds the $200,000 accredited-investor threshold',
      disclosureMode: 'ATTESTATION',
      spec: {
        kind: 'transaction',
        from: '2025-01-01',
        to: '2026-01-01',
        structured: { type: 'income-threshold', threshold: 200000, currency: 'USD', period: '2025', result: 'exceeds' },
      },
    },
    witnessId.did,
    delegationValid,
  );
  if (resp.status !== 'granted') throw new Error(`expected granted, got ${JSON.stringify(resp)}`);
  process.stdout.write(`minted evidence graph: ${resp.credentialDid.slice(0, 30)}…\n`);

  // 4. Sovereign accepts the minted evidence graph.
  if (!(await acceptCredential(sovereign, resp.credentialDid))) {
    throw new Error('Sovereign failed to accept the evidence graph');
  }

  // 5. Verifier (the fund / onboarding desk) verifies — trusting the WARDEN as issuer.
  const challenge = await requestProof(verifier, {
    schema: resp.schemaDid,
    trustedIssuers: [wardenId.did],
  });
  const presentation = await presentProof(sovereign, challenge);
  const result = await verifyProof(verifier, presentation, {
    trustedIssuers: [wardenId.did],
    schema: resp.schemaDid,
  });
  if (!result.ok) throw new Error(`verification failed: ${JSON.stringify(result)}`);

  const claims = result.disclosed[0]?.claims ?? {};
  const group = ((claims.evidence as unknown[] | undefined) ?? [])[0] as
    | { kind?: string; count?: number; commitment?: { merkleRoot?: string } }
    | undefined;
  process.stdout.write(
    `\n✓ VERIFIED (issuer = Warden, trust class witnessed)\n` +
      `  claim:      ${String(claims.claim)}\n` +
      `  structured: ${JSON.stringify(claims.structured)}\n` +
      `  evidence:   kind=${group?.kind} count=${group?.count} root=${group?.commitment?.merkleRoot?.slice(0, 12)}…\n` +
      `  (the verifier learns the threshold is met + that ${group?.count} records back it — never the figures)\n`,
  );

  if (!group || group.count !== 4) throw new Error(`evidence group missing/wrong count: ${JSON.stringify(group)}`);
  process.stdout.write(`\n✓ Finance A1 evidence graph: assemble → mint → present → verify\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-finance-evidence: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
