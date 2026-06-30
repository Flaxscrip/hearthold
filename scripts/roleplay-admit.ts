/**
 * Roleplay back-end: admit one member to the existing Drake Gamers Guild board.
 *
 * Reuses the founded board (group + DTG schema + Registry/Warden in the data root) and admits the
 * member named by env: VMC (membership) + VEC (role) from the community, a Warden VWC of the form-up,
 * and a grant into the board group.
 *
 * Run:  MEMBER_DID=… ROLE=… LABEL=… HEARTHOLD_DATA_ROOT=… node --experimental-strip-types scripts/roleplay-admit.ts
 */

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  issueVmc,
  issueVec,
  issueVwc,
  grantAuthorization,
  type KeymasterHandle,
} from '@hearthold/core';

const PASS = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-roleplay';
const BOARD_GROUP = process.env.BOARD_GROUP ?? 'did:cid:bagaaiera3gqizewooxllarg33lg2in34frdjqodcmywiai4mo6u6ogihfnua';
const SCHEMA = process.env.SCHEMA ?? 'did:cid:bagaaierapdi6qlte3zo4u3svpfmjq2oujdcksnf6kric2rglxtwsx4r6f7uq';
const SESSION = process.env.SESSION ?? 'drake-gamers-formup-001';
const MEMBER_DID = process.env.MEMBER_DID ?? '';
const ROLE = process.env.ROLE ?? 'Member';
const LABEL = process.env.LABEL ?? 'member';

const line = (m = ''): void => process.stdout.write(`${m}\n`);

async function main(): Promise<void> {
  if (!MEMBER_DID) throw new Error('MEMBER_DID is required');
  const config = loadConfig();
  const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();

  const registry: KeymasterHandle = await openKeymaster('registry', config, PASS);
  const warden: KeymasterHandle = await openKeymaster('warden', config, PASS);
  await ensureIdentity(registry, config);
  await ensureIdentity(warden, config);

  const vmc = await issueVmc(registry, MEMBER_DID, SCHEMA, validUntil);
  const vmcVc = await registry.keymaster.getCredential(vmc);
  const vec = await issueVec(
    registry,
    MEMBER_DID,
    SCHEMA,
    { type: 'SkillEndorsement', name: ROLE, competencyLevel: 'expert' },
    validUntil,
  );
  const vwc = await issueVwc(warden, MEMBER_DID, SCHEMA, {
    witnessedVrc: vmcVc,
    witnessContext: { event: 'Drake Gamers Guild form-up', sessionId: SESSION, method: 'virtual-realtime' },
    validUntil,
  });
  await grantAuthorization(registry, BOARD_GROUP, MEMBER_DID);

  const group = await registry.keymaster.getGroup(BOARD_GROUP);
  line(`Admitted ${LABEL}  ·  ${ROLE}`);
  line(`  did: ${MEMBER_DID}`);
  line(`  VMC: ${vmc}`);
  line(`  VEC: ${vec}`);
  line(`  VWC: ${vwc}`);
  line(`  board group now has ${group?.members?.length ?? 0} member(s).`);
}

main().catch((err: unknown) => {
  process.stderr.write(`roleplay error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
