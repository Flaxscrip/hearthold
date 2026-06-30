/**
 * End-to-end test of the full DTG credential set on Archon: VRC, VMC, VIC, VPC, VEC, VWC + the RCard
 * VDS. Issues one of each, reads it back, and checks the node persisted the right DTG type hierarchy
 * and credentialSubject shape.
 *
 * Roles: issuer/community/witness/publisher = warden id; subject/member/observed = sovereign id.
 *
 * Run:  npm run e2e:dtg-set
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  dtgSchema,
  DtgType,
  RCARD_TYPE,
  issueVrc,
  issueVmc,
  issueVic,
  issueVpc,
  issueVec,
  issueVwc,
  issueRCard,
  type KeymasterHandle,
} from '@hearthold/core';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(`Hearthold DTG credential set e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision issuer (warden) and subject (sovereign)');
  const issuer: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const subject: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE);
  const issuerId = await ensureIdentity(issuer, config);
  const subjectId = await ensureIdentity(subject, config);
  check('identities ready', issuerId.did.startsWith('did:') && subjectId.did.startsWith('did:'));

  // One open DTG schema serves every subtype (the subtype lives in the top-level `type` array).
  const schema = await issuer.keymaster.createSchema(dtgSchema('DTGCredential'));
  const get = (did: string) => issuer.keymaster.getCredential(did);

  step('Issue one of each DTG type to the subject');
  const vrcDid = await issueVrc(issuer, subjectId.did, schema);
  const vrc = await get(vrcDid);
  check('VRC → RelationshipCredential', !!vrc && vrc.type.includes(DtgType.RELATIONSHIP) && vrc.type.includes(DtgType.BASE));

  const vmc = await get(await issueVmc(issuer, subjectId.did, schema));
  check('VMC → MembershipCredential', !!vmc && vmc.type.includes(DtgType.MEMBERSHIP) && vmc.type.includes(DtgType.BASE));

  const vic = await get(await issueVic(issuer, subjectId.did, schema));
  check('VIC → InvitationCredential', !!vic && vic.type.includes(DtgType.INVITATION));

  const vpc = await get(await issueVpc(issuer, subjectId.did, schema));
  check('VPC → PersonaCredential', !!vpc && vpc.type.includes(DtgType.PERSONA));

  const vec = await get(
    await issueVec(issuer, subjectId.did, schema, { type: 'SkillEndorsement', name: 'Raid Leadership', competencyLevel: 'expert' }),
  );
  const endorsement = (vec?.credentialSubject?.endorsement ?? {}) as Record<string, unknown>;
  check('VEC → EndorsementCredential', !!vec && vec.type.includes(DtgType.ENDORSEMENT));
  check('VEC carries the endorsement (name = Raid Leadership)', endorsement.name === 'Raid Leadership');

  const vwc = await get(
    await issueVwc(issuer, subjectId.did, schema, {
      witnessedVrc: vrc,
      witnessContext: { event: 'Example Guild raid form-up', sessionId: 'session-drake-7731', method: 'virtual-realtime' },
    }),
  );
  const wctx = (vwc?.credentialSubject?.witnessContext ?? {}) as Record<string, unknown>;
  check('VWC → WitnessCredential', !!vwc && vwc.type.includes(DtgType.WITNESS));
  check('VWC carries witnessContext + digest of the VRC', wctx.sessionId === 'session-drake-7731' && typeof vwc?.credentialSubject?.digest === 'string');

  const rcard = await get(
    await issueRCard(issuer, subjectId.did, schema, ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Drake Raid-Lead']]]),
  );
  check('RCard → RelationshipCard VDS (no DTGCredential parent)', !!rcard && rcard.type.includes(RCARD_TYPE) && !rcard.type.includes(DtgType.BASE));
  check('RCard carries a jCard', Array.isArray(rcard?.credentialSubject?.card));

  process.stdout.write(`\n${failures === 0 ? 'PASS — full DTG set issues + round-trips on Archon' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
