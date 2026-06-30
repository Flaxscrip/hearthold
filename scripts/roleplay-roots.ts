/**
 * Roleplay back-end: ignite more roots on the existing Drake Gamers Guild board.
 *
 * Reuses the board founded by roleplay-board.ts (its group + DTG schema + Registry/Warden identities
 * in the same data root) and admits more members — each gets VMC (membership) + VEC (role) from the
 * board community, a Warden VWC of the form-up, and a grant into the board group.
 *
 * Members: flaxscrip (a real, Bitcoin-anchored DID) + two minted co-founder NPCs.
 *
 * Run:  HEARTHOLD_DATA_ROOT=… node --experimental-strip-types scripts/roleplay-roots.ts
 */

import { join } from 'node:path';

import Keymaster, { WalletJson } from '@didcid/keymaster';
import GatekeeperClient from '@didcid/gatekeeper/client';
import CipherNode from '@didcid/cipher/node';

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
const FLAXSCRIP = 'did:cid:bagaaiera7vsjlu6oiluzd4enop5j7sfzjbwp2ujudt6uunkz6hhd4lgfe4sa';

const line = (m = ''): void => process.stdout.write(`${m}\n`);

async function main(): Promise<void> {
  const config = loadConfig();
  const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();

  const registry: KeymasterHandle = await openKeymaster('registry', config, PASS);
  const warden: KeymasterHandle = await openKeymaster('warden', config, PASS);
  await ensureIdentity(registry, config);
  await ensureIdentity(warden, config);

  // A side wallet for the minted co-founder NPCs (separate from the back-end identities).
  const cofounders = new Keymaster({
    passphrase: PASS,
    gatekeeper: await GatekeeperClient.create({ url: config.nodeUrl }),
    wallet: new WalletJson('wallet.json', join(config.dataRoot, 'cofounders')),
    cipher: new CipherNode(),
    defaultRegistry: config.registry,
  });
  const mint = async (name: string): Promise<string> => {
    const ids = await cofounders.listIds();
    if (!ids.includes(name)) await cofounders.createId(name, { registry: config.registry });
    await cofounders.setCurrentId(name);
    return cofounders.resolveDID(name).then((d) => d.didDocument?.id ?? '');
  };

  interface Root { root: string; label: string; did: string; role: string; vmc?: string; vec?: string; vwc?: string }
  const roots: Root[] = [
    { root: 'II', label: 'flaxscrip', did: FLAXSCRIP, role: 'Guild Founder' },
    { root: 'III', label: 'Quartermaster (NPC)', did: await mint('root-quartermaster'), role: 'Quartermaster' },
    { root: 'IV', label: 'Lorekeeper (NPC)', did: await mint('root-lorekeeper'), role: 'Lorekeeper' },
  ];

  for (const r of roots) {
    const vmc = await issueVmc(registry, r.did, SCHEMA, validUntil);
    const vmcVc = await registry.keymaster.getCredential(vmc);
    const vec = await issueVec(
      registry,
      r.did,
      SCHEMA,
      { type: 'SkillEndorsement', name: r.role, competencyLevel: 'expert' },
      validUntil,
    );
    const vwc = await issueVwc(warden, r.did, SCHEMA, {
      witnessedVrc: vmcVc,
      witnessContext: { event: 'Drake Gamers Guild form-up', sessionId: SESSION, method: 'virtual-realtime' },
      validUntil,
    });
    await grantAuthorization(registry, BOARD_GROUP, r.did);
    r.vmc = vmc;
    r.vec = vec;
    r.vwc = vwc;
  }

  line('════════ ROOTS IGNITED ════════');
  for (const r of roots) {
    line(`  Root ${r.root}  ●  ${r.label}  ·  ${r.role}`);
    line(`     did: ${r.did}`);
    line(`     VMC ${r.vmc?.slice(0, 24)}…  VEC ${r.vec?.slice(0, 24)}…  VWC ${r.vwc?.slice(0, 24)}…`);
  }
  // Confirm the board's registry now lists everyone.
  const group = await registry.keymaster.getGroup(BOARD_GROUP);
  line(`\n  board group now has ${group?.members?.length ?? 0} member(s).`);
}

main().catch((err: unknown) => {
  process.stderr.write(`roleplay error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
