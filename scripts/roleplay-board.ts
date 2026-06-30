/**
 * Roleplay back-end: found the Drake Gamers Guild board and admit the Sovereign.
 *
 * Plays the home/back-end actors — Registry (the board community C-DID) + Warden (custody + fair
 * witness). Takes the world-side Sovereign + Witness DIDs via env and:
 *   - creates the board group + a membership binding (Registry)
 *   - issues the Sovereign a VMC (membership) + VEC (role) from the board community
 *   - issues a VWC (Warden as fair witness) attesting the form-up, digesting the VMC
 *   - grants the Sovereign into the board group
 *   - issues the Witness a scoped delegation
 * Prints every artifact DID + the accept commands the world-side runs next.
 *
 * Run:  SOVEREIGN_DID=… WITNESS_DID=… HEARTHOLD_DATA_ROOT=… node --experimental-strip-types scripts/roleplay-board.ts
 */

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  dtgSchema,
  issueVmc,
  issueVec,
  issueVwc,
  createRegistryGroup,
  grantAuthorization,
  type KeymasterHandle,
} from '@hearthold/core';

const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-roleplay';
const SOVEREIGN_DID = process.env.SOVEREIGN_DID ?? '';
const WITNESS_DID = process.env.WITNESS_DID ?? '';
const BOARD = process.env.BOARD ?? 'Drake Gamers Guild';
const SESSION = process.env.SESSION ?? 'drake-gamers-formup-001';

const line = (m = ''): void => process.stdout.write(`${m}\n`);

async function main(): Promise<void> {
  if (!SOVEREIGN_DID || !WITNESS_DID) throw new Error('SOVEREIGN_DID and WITNESS_DID are required');
  const config = loadConfig();
  line(`Founding the "${BOARD}" board\n  node: ${config.nodeUrl}\n  data: ${config.dataRoot}`);

  // Back-end identities.
  const registry: KeymasterHandle = await openKeymaster('registry', config, PASSPHRASE);
  const warden: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const verifier: KeymasterHandle = await openKeymaster('verifier', config, PASSPHRASE);
  const registryId = await ensureIdentity(registry, config);
  const wardenId = await ensureIdentity(warden, config);
  const verifierId = await ensureIdentity(verifier, config);

  // One open DTG schema serves every subtype here.
  const schema = await registry.keymaster.createSchema(dtgSchema('DTGCredential'));
  const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();

  // 1) Found the board: a group whose membership = belonging to the board.
  const boardGroup = await createRegistryGroup(registry, `hearthold-board-${BOARD.replace(/\W+/g, '-')}`, config.registry);

  // 2) Admit the Sovereign — VMC (membership) + VEC (role) from the board community (Registry C-DID).
  const vmc = await issueVmc(registry, SOVEREIGN_DID, schema, validUntil);
  const vmcVc = await registry.keymaster.getCredential(vmc);
  const vec = await issueVec(
    registry,
    SOVEREIGN_DID,
    schema,
    { type: 'SkillEndorsement', name: 'Raid Leadership', competencyLevel: 'expert' },
    validUntil,
  );

  // 3) Witness the form-up — VWC by the Warden acting as the board's fair witness, digesting the VMC.
  const vwc = await issueVwc(warden, SOVEREIGN_DID, schema, {
    witnessedVrc: vmcVc,
    witnessContext: { event: `${BOARD} form-up`, sessionId: SESSION, method: 'virtual-realtime' },
    validUntil,
  });

  // 4) Grant the Sovereign into the board group (registry-side membership).
  await grantAuthorization(registry, boardGroup, SOVEREIGN_DID);

  // 5) Delegate to the Witness so it can act for the Sovereign.
  const delegationSchema = await ensureDelegationSchema(warden);
  const delegation = await issueDelegation(warden, WITNESS_DID, delegationSchema, {
    kinds: ['event', 'activity'],
    validUntil,
  });

  line();
  line('════════ BOARD FOUNDED ════════');
  line(`  board:            ${BOARD}  (session ${SESSION})`);
  line(`  board group:      ${boardGroup}`);
  line(`  community (C-DID): ${registryId.did}   [Registry — issues membership]`);
  line(`  warden:           ${wardenId.did}   [custody + fair witness]`);
  line(`  verifier:         ${verifierId.did}   [relying party]`);
  line(`  dtg schema:       ${schema}`);
  line();
  line('  Credentials issued to the Sovereign:');
  line(`    VMC membership:  ${vmc}`);
  line(`    VEC role:        ${vec}   (Raid Leadership · expert)`);
  line(`    VWC form-up:     ${vwc}   (witnessed by the Warden)`);
  line(`    delegation→Witness: ${delegation}   (kinds: event, activity)`);
  line();
  line('  WORLD-SIDE, run next:');
  line(`    npm run -s sovereign -- accept ${vmc}`);
  line(`    npm run -s sovereign -- accept ${vec}`);
  line(`    npm run -s witness   -- accept ${delegation}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`roleplay error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
