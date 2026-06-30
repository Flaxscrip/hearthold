/**
 * Roleplay: make the Drake Gamers Guild board run *on* the trust registry (TRQP), not just store data
 * in it. Registers two bindings and runs real TRQP authorization queries against the live board:
 *
 *   - issuer authorization: is the board community authorized to ISSUE GuildMembership? (issue+schema)
 *   - membership:          is this DID a MEMBER of Drake Gamers Guild?                  (member+guild)
 *
 * Writes the registry's BindingStore so `registry serve`/`check` can answer over TRQP HTTP too.
 * This is the DTG "thin credential, fat registry" principle and the HATPro pattern, on Archon groups.
 *
 * Run:  HEARTHOLD_DATA_ROOT=…/.hearthold-roleplay node --experimental-strip-types scripts/roleplay-registry.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  agentDataFolder,
  createRegistryGroup,
  grantAuthorization,
  GroupTrustRegistry,
  type KeymasterHandle,
  type GroupBinding,
} from '@hearthold/core';

const PASS = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-roleplay';
const GUILD = 'Drake Gamers Guild';
const COMMUNITY = 'did:cid:bagaaieravkejyffsygijy7cpmq3ll24x4hyv2wrpkaoeylci74mhhsxdus3q'; // the C-DID (= registry id)
const BOARD_GROUP = 'did:cid:bagaaiera3gqizewooxllarg33lg2in34frdjqodcmywiai4mo6u6ogihfnua';
const SCHEMA = 'did:cid:bagaaierapdi6qlte3zo4u3svpfmjq2oujdcksnf6kric2rglxtwsx4r6f7uq';
const MEMBERS: Record<string, string> = {
  Sovereign: 'did:cid:bagaaieraeckzoz4g2cb2xices6ier6strr3t7bmpwjtkryn7fxymttpxe46a',
  flaxscrip: 'did:cid:bagaaiera7vsjlu6oiluzd4enop5j7sfzjbwp2ujudt6uunkz6hhd4lgfe4sa',
  GenitriX: 'did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq',
};
const NON_MEMBER = 'did:cid:bagaaieraty3o7zbiygqzlbnx5ejopg2kxdg5oss5gifcsoelkcuxm3sqy25a'; // the verifier — not a member

const line = (m = ''): void => process.stdout.write(`${m}\n`);
let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  line(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const registry: KeymasterHandle = await openKeymaster('registry', config, PASS);
  const id = await ensureIdentity(registry, config);
  line(`Drake Gamers Guild · trust registry\n  registry (authority): ${id.did}`);

  // 1) An issuers group authorizing the community to issue GuildMembership.
  const issuersGroup = await createRegistryGroup(registry, 'hearthold-issuers-guildmembership', config.registry);
  await grantAuthorization(registry, issuersGroup, COMMUNITY);

  // 2) Two bindings: issuer-authorization (issue+schema) and membership (member+guild → the board group).
  const bindings: GroupBinding[] = [
    { action: 'issue', resource: SCHEMA, group: issuersGroup },
    { action: 'member', resource: GUILD, group: BOARD_GROUP },
  ];

  // Persist the store so `registry serve` / `registry check` answer over TRQP HTTP too.
  const folder = agentDataFolder(config, 'registry');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'hearthold-registry.json'), JSON.stringify({ bindings }, null, 2) + '\n', 'utf8');

  const reg = new GroupTrustRegistry(registry, bindings, id.did);

  line('\n▸ Issuer authorization — does the registry authorize the community to issue GuildMembership?');
  const ia = await reg.authorize({ entity_id: COMMUNITY, action: 'issue', resource: SCHEMA });
  check('community authorized to issue (issue + schema)', ia.authorized === true, ia.message);

  line('\n▸ Membership — is each DID a member of Drake Gamers Guild? (the guild\'s source of truth)');
  for (const [name, did] of Object.entries(MEMBERS)) {
    const r = await reg.authorize({ entity_id: did, action: 'member', resource: GUILD });
    check(`${name} is a member`, r.authorized === true, r.message);
  }
  const nm = await reg.authorize({ entity_id: NON_MEMBER, action: 'member', resource: GUILD });
  check('a non-member is refused', nm.authorized === false, nm.message);

  line(`\n  bindings written → ${join(folder, 'hearthold-registry.json')}`);
  line(`  (run \`registry serve\` in this data root to answer the same queries over TRQP HTTP)`);
  line(`\n${failures === 0 ? 'PASS — the board runs on the registry' : `FAIL (${failures})`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`roleplay error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
