/**
 * e2e: the vault→VP path (milestone A1).
 *
 * Seeds the Warden's vault with witnessed observations, has the Warden assemble + mint a signed
 * evidence graph over them (trust class `witnessed`), the Sovereign accept it, and a verifier verify
 * it — trusting the WARDEN as the issuer. Proves: assemble → mint → present → verify.
 *
 * Isolated under a throwaway data root; run:  npm run e2e:evidence
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
  const pass = 'hearthold-e2e-evidence';

  const warden = await openKeymaster('warden', config, pass);
  const witness = await openKeymaster('witness', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);

  // 1. Warden delegates the Witness (authorizes the evidence request).
  const delSchema = await ensureDelegationSchema(warden);
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const delCred = await issueDelegation(warden, witnessId.did, delSchema, {
    kinds: ['event', 'location'],
    validUntil: oneYear,
  });
  await new DelegationStore(warden).record(witnessId.did, delCred);

  // 2. Seed the vault with three PUBLIC 'event' observations (deterministic — no classifier).
  const store = new VaultStore(warden.dataFolder);
  const days = ['2026-06-01', '2026-06-08', '2026-06-15'];
  for (const [i, day] of days.entries()) {
    await store.put({
      id: hex(`event-${i}`),
      kind: 'event',
      observedAt: `${day}T18:00:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.PUBLIC,
      ciphertext: '(sealed)',
      metadata: { witness: witnessId.did },
    });
  }
  process.stdout.write(`seeded ${days.length} PUBLIC event artefacts\n`);

  // 3. Witness requests evidence → Warden assembles + mints the graph.
  const evidence = new EvidenceService(warden, { ...config, sovereignDid: sovId.did });
  const delegationValid = await new DelegationStore(warden).isAuthorized(witnessId.did);
  const resp = await evidence.handle(
    {
      type: 'hearthold/evidence-request',
      version: PROTOCOL_VERSION,
      claim: 'Attended the Drake Gamers Guild summer meetups',
      disclosureMode: 'ATTESTATION',
      spec: {
        kind: 'event',
        from: '2026-06-01',
        to: '2026-06-30',
        structured: { type: 'attendance', event: 'summer-meetups', season: '2026' },
      },
    },
    witnessId.did,
    delegationValid,
  );
  if (resp.status !== 'granted') throw new Error(`expected granted, got ${JSON.stringify(resp)}`);
  process.stdout.write(`minted evidence graph: ${resp.credentialDid.slice(0, 30)}…\n`);

  // 4. Sovereign accepts the minted evidence graph (now holds a witnessed leaf).
  if (!(await acceptCredential(sovereign, resp.credentialDid))) {
    throw new Error('Sovereign failed to accept the evidence graph');
  }

  // 5. Verifier verifies — trusting the WARDEN as issuer of the witnessed claim.
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
      `  claim:     ${String(claims.claim)}\n` +
      `  structured: ${JSON.stringify(claims.structured)}\n` +
      `  evidence:  kind=${group?.kind} count=${group?.count} root=${group?.commitment?.merkleRoot?.slice(0, 12)}…\n`,
  );

  if (!group || group.count !== 3) throw new Error(`evidence group missing/wrong count: ${JSON.stringify(group)}`);
  process.stdout.write(`\n✓ A1 evidence graph: assemble → mint → present → verify\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-evidence: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
