/**
 * e2e: composite evidence — witnessed + `issued` leaves (the F6 case).
 *
 * A landlord (external issuer) issues a ResidenceLease to the Sovereign. The Warden composes an
 * evidence graph over the Sovereign's witnessed location pings AND that issued lease. In one
 * presentation the Sovereign discloses both, and a verifier checks **each issuer** — the Warden for
 * the witnessed graph, the *landlord* for the lease. Now a skeptical verifier trusts a third party,
 * not just the Warden. The negative (verifier doesn't trust the landlord) is rejected.
 *
 * Isolated data root; run:  npm run e2e:evidence-composite
 */
import { createHash } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  ensureSchema,
  openSchema,
  issueClaim,
  acceptCredential,
  recordIssuedCredential,
  requestCompositeProof,
  presentProof,
  verifyProof,
  Sensitivity,
  PROTOCOL_VERSION,
  type EvidenceRequest,
  type ApprovalResponseMessage,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService, type SovereignApprover } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-composite';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const witness = await openKeymaster('witness', config, pass);
  const landlord = await openKeymaster('registry', config, pass); // an external issuer (wallet slot)
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);
  const witnessId = await ensureIdentity(witness, config);
  const landlordId = await ensureIdentity(landlord, config);

  // The landlord issues a ResidenceLease to the Sovereign; the Sovereign accepts + records it.
  const leaseSchema = await ensureSchema(landlord, 'ResidenceLease', openSchema('ResidenceLease'));
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const leaseDid = await issueClaim(
    landlord,
    sovId.did,
    leaseSchema,
    { type: 'ResidenceLease', country: 'FR', address: '12 rue Example, Paris', term: '2026' },
    oneYear,
  );
  await acceptCredential(sovereign, leaseDid);
  await recordIssuedCredential(sovereign, leaseDid, warden.dataFolder); // recorded into the Warden's vault
  process.stdout.write(`landlord issued a ResidenceLease; recorded as an issued leaf\n`);

  // Witnessed side: delegate the Witness, seed MEDIUM location pings.
  const delSchema = await ensureDelegationSchema(warden);
  const delCred = await issueDelegation(warden, witnessId.did, delSchema, { kinds: ['location'], validUntil: oneYear });
  await new DelegationStore(warden).record(witnessId.did, delCred);
  const store = new VaultStore(warden.dataFolder);
  for (const [i, d] of ['2026-02-04', '2026-03-11', '2026-04-20'].entries()) {
    await store.put({
      id: hex(`loc-${i}`),
      kind: 'location',
      observedAt: `${d}T09:00:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.MEDIUM,
      ciphertext: '(sealed)',
      metadata: { witness: witnessId.did },
    });
  }

  // Warden composes the graph (witnessed pings + the issued lease), co-signed via the Signet.
  const approver: SovereignApprover = {
    async requestApproval(req) {
      const handler = makeSovereignHandler(sovereign, new PinGate('4242', '4242'));
      return (await handler(req, wardenId.did)) as ApprovalResponseMessage;
    },
  };
  const evidence = new EvidenceService(warden, { ...config, sovereignDid: sovId.did }, approver);
  const delegationValid = await new DelegationStore(warden).isAuthorized(witnessId.did);
  const req: EvidenceRequest = {
    type: 'hearthold/evidence-request',
    version: PROTOCOL_VERSION,
    claim: 'Resided in FR during 2026-H1',
    disclosureMode: 'ATTESTATION',
    spec: { kind: 'location', from: '2026-01-01', to: '2026-06-30' },
    subjectDid: sovId.did,
    with: [leaseDid],
  };
  const granted = await evidence.handle(req, witnessId.did, delegationValid);
  assert(granted.status === 'granted', 'composite claim granted');
  if (granted.status !== 'granted') throw new Error('not granted');
  assert(granted.graph?.trustClass === 'composite', 'graph trust class is composite');
  assert(granted.graph?.issued?.[0]?.issuer === landlordId.did, 'graph lists the landlord as an issued-leaf issuer');
  await acceptCredential(sovereign, granted.credentialDid);

  process.stdout.write('\n▸ Composite presentation — verifier requires the graph AND the lease\n');
  const challenge = await requestCompositeProof(verifier, [
    { schema: granted.schemaDid, trustedIssuers: [wardenId.did] },
    { schema: leaseSchema, trustedIssuers: [landlordId.did] },
  ]);
  const presentation = await presentProof(sovereign, challenge);
  const result = await verifyProof(verifier, presentation, { trustedIssuers: [wardenId.did, landlordId.did] });
  assert(result.ok, 'verifier verifies BOTH the witnessed graph and the third-party lease');
  assert(result.disclosed.length === 2, 'two leaves disclosed');
  const fromLandlord = result.disclosed.find((d) => d.issuer === landlordId.did);
  assert(!!fromLandlord, 'one leaf is signed by the landlord (a third party)');
  assert(fromLandlord?.claims.country === 'FR', 'the landlord-attested lease says country = FR');

  process.stdout.write('\n▸ Negative: a verifier that does NOT trust the landlord is not satisfied\n');
  const distrust = await verifyProof(verifier, presentation, { trustedIssuers: [wardenId.did] });
  assert(!distrust.ok, 'without trusting the landlord, the composite is rejected');

  process.stdout.write('\n✓ Composite evidence: witnessed + issued, each verified against its own issuer\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-evidence-composite: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
