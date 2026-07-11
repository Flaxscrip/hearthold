/**
 * e2e: DTG v0.3 conformance deltas (A2A brief §4b / H3).
 *
 *   1. VC 1.1 → 2.0 verify fallback (SHOULD): a v1.1-shaped DTG credential normalizes to 2.0 by mapping
 *      only the moved fields (2018 context → 2.0, issuanceDate → validFrom, expirationDate → validUntil);
 *      a 2.0 credential passes through unchanged. Fixture test.
 *   2. PHC type hint (optional): issueVmc can append 'PersonhoodCredential' to a VMC's type array when
 *      the community's governance warrants it — non-authoritative per spec; off by default.
 *
 * Isolated data root; run:  npm run e2e:dtg-compat
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureSchema,
  openSchema,
  acceptCredential,
  issueVmc,
  mapVc11ToVc2,
  W3C_VC1_CONTEXT,
  W3C_VC2_CONTEXT,
  DTG_CONTEXT,
} from '@hearthold/core';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-dtg-compat';

  // ── 1. VC 1.1 → 2.0 verify fallback (pure fixture, no node needed) ──
  const v11 = {
    '@context': [W3C_VC1_CONTEXT, DTG_CONTEXT],
    type: ['VerifiableCredential', 'DTGCredential', 'RelationshipCredential'],
    issuer: 'did:cid:example-issuer',
    issuanceDate: '2026-01-01T00:00:00Z',
    expirationDate: '2027-01-01T00:00:00Z',
    credentialSubject: { id: 'did:cid:example-subject' },
  };
  const v2 = mapVc11ToVc2(v11);
  assert(v2.validFrom === '2026-01-01T00:00:00Z', 'issuanceDate → validFrom');
  assert(v2.validUntil === '2027-01-01T00:00:00Z', 'expirationDate → validUntil');
  assert(!('issuanceDate' in v2) && !('expirationDate' in v2), 'v1.1 date fields are removed after mapping');
  assert((v2['@context'] as string[]).includes(W3C_VC2_CONTEXT), '2.0 context present');
  assert(!(v2['@context'] as string[]).includes(W3C_VC1_CONTEXT), '2018 context replaced');
  assert(JSON.stringify(v2.type) === JSON.stringify(v11.type), 'DTG type hierarchy preserved');
  assert((v2['@context'] as string[]).includes(DTG_CONTEXT), 'DTG context preserved');
  // Passthrough: mapping an already-2.0 credential is a no-op on the moved fields.
  const again = mapVc11ToVc2(v2);
  assert(again.validFrom === v2.validFrom && !('issuanceDate' in again), 'a 2.0 credential passes through unchanged');
  process.stdout.write('✓ [1] VC 1.1 → 2.0 fallback: context + date fields mapped, types preserved, 2.0 passthrough\n');

  // ── 2. PHC type hint on issueVmc (live issuance) ──
  const community = await openKeymaster('warden', config, pass);
  const member = await openKeymaster('sovereign', config, pass);
  await ensureIdentity(community, config);
  const memberId = await ensureIdentity(member, config);
  const schema = await ensureSchema(community, 'DtgMembership', openSchema('DtgMembership'));

  const phcVmc = await issueVmc(community, memberId.did, schema, undefined, { personhood: true });
  assert(await acceptCredential(member, phcVmc), 'member accepts the PHC-hinted VMC');
  const phcType = ((await member.keymaster.getCredential(phcVmc)) as unknown as { type?: string[] })?.type ?? [];
  assert(phcType.includes('MembershipCredential') && phcType.includes('PersonhoodCredential'), `PHC-hinted VMC must carry both types (got ${JSON.stringify(phcType)})`);

  const plainVmc = await issueVmc(community, memberId.did, schema);
  assert(await acceptCredential(member, plainVmc), 'member accepts the plain VMC');
  const plainType = ((await member.keymaster.getCredential(plainVmc)) as unknown as { type?: string[] })?.type ?? [];
  assert(plainType.includes('MembershipCredential') && !plainType.includes('PersonhoodCredential'), 'a plain VMC carries no PHC hint by default');
  process.stdout.write('✓ [2] PHC hint: opt-in appends PersonhoodCredential; off by default\n');

  process.stdout.write('\n✓ DTG v0.3 conformance deltas (VC 1.1 fallback + PHC hint)\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-dtg-compat: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
