/**
 * Does moving the Warden IDENTITY to hyperswarm leak WHO is a member?
 *
 * The login fix moves the Warden's identity local→hyperswarm so login challenges resolve off-node. archon-ops's
 * concern: the T3 argument was that born-local access-control keeps membership OFF the gossip network. That holds
 * only if the access-control GROUPS stay `local` after the move — i.e. a hyperswarm-identity Warden can still
 * create/manage/testGroup a `local` group, and those groups don't gossip. Verify it rather than assert it.
 *
 *   PASS  → groups stay local, membership stays private, T3's no-leak argument still holds.
 *   FAIL  → group ops are forced onto hyperswarm (membership gossips) — a real, deliberate trade to document.
 *
 * Run on flaxlap (has both registries):
 *   HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_PASSPHRASE=… node --experimental-strip-types scripts/e2e-changeregistry-groups.ts
 */
import { loadConfig, openKeymaster, ensureIdentity, createRegistryGroup, grantAuthorization, IDENTITY_NAME } from '@hearthold/core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (c: boolean, m: string): void => { process.stdout.write(`  ${c ? '✓' : '✗ FAIL'} ${m}\n`); if (!c) process.exitCode = 1; };

async function groupRegistry(warden: Awaited<ReturnType<typeof openKeymaster>>, group: string): Promise<string | undefined> {
  const doc = (await warden.keymaster.resolveDID(group, { confirm: false }).catch(() => undefined)) as { didDocumentRegistration?: { registry?: string } } | undefined;
  return doc?.didDocumentRegistration?.registry;
}

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE ?? 'changereg-groups';
  const local = { ...base, registry: 'local', contentRegistry: 'local', ephemeralRegistry: 'local' };
  const warden = await openKeymaster('warden', local, pass);
  const memberA = await openKeymaster('sovereign', local, pass);
  const memberB = await openKeymaster('verifier', local, pass);
  const wid = await ensureIdentity(warden, local);
  const aId = await ensureIdentity(memberA, local);
  const bId = await ensureIdentity(memberB, local);

  process.stdout.write('\n▸ 1. BEFORE the move — local group + one member\n');
  const group = await createRegistryGroup(warden, `xreg-groups-${Date.now() % 100000}`, 'local');
  await grantAuthorization(warden, group, aId.did);
  ok((await warden.keymaster.testGroup(group, aId.did).catch(() => false)) === true, 'local group authorizes member A');
  ok((await groupRegistry(warden, group)) === 'local', 'the group is registered `local`');

  process.stdout.write('\n▸ 2. Move the Warden IDENTITY local→hyperswarm, wait for confirm\n');
  const km = warden.keymaster as unknown as { changeRegistry(idName: string, registry: string): Promise<boolean> };
  process.stdout.write(`  changeRegistry: ${await km.changeRegistry(IDENTITY_NAME.warden, 'hyperswarm').catch((e: unknown) => `ERR:${e instanceof Error ? e.message : e}`)}\n`);
  let reg: string | undefined;
  for (let i = 0; i < 40; i++) { await warden.gatekeeper.processEvents().catch(() => {}); const d = (await warden.keymaster.resolveDID(wid.did, { confirm: true }).catch(() => undefined)) as { didDocumentRegistration?: { registry?: string } } | undefined; reg = d?.didDocumentRegistration?.registry; if (reg === 'hyperswarm') break; await sleep(3000); }
  await warden.keymaster.loadWallet();
  ok(reg === 'hyperswarm', `Warden identity confirmed on hyperswarm (got ${reg})`);

  process.stdout.write('\n▸ 3. AFTER the move — can a hyperswarm-identity Warden still manage its LOCAL group?\n');
  ok((await warden.keymaster.testGroup(group, aId.did).catch(() => false)) === true, 'still authorizes member A (read membership works)');
  let granted = false;
  try { await grantAuthorization(warden, group, bId.did); granted = true; } catch (e) { process.stdout.write(`    grant B threw: ${e instanceof Error ? e.message : String(e)}\n`); }
  ok(granted, 'can add a NEW member B to the local group (manage membership works)');
  ok((await warden.keymaster.testGroup(group, bId.did).catch(() => false)) === true, 'authorizes the newly-added member B');
  const finalReg = await groupRegistry(warden, group);
  ok(finalReg === 'local', `the group STAYS registered \`local\` after the move (got ${finalReg}) — membership does NOT gossip`);

  process.stdout.write(
    process.exitCode === 1
      ? '\n✗ A hyperswarm-identity Warden could NOT fully keep its groups local — membership may gossip. Document the trade.\n'
      : '\n✓ Groups stay `local` and remain fully manageable after the Warden identity moves to hyperswarm.\n  Membership stays OFF the gossip network — T3’s no-leak argument still holds.\n',
  );
}

main().catch((err) => { process.stderr.write(`e2e-changeregistry-groups: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`); process.exit(1); });
