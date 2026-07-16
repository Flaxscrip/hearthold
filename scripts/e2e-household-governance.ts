/**
 * e2e: household admit/remove — with Fable watch-item #1 (guardianship-threat-model §4.3): a removed
 * member's ALREADY-UNWRAPPED read-guest key dies on REMOVAL, immediately — not at TTL. Verified against a
 * partition-sealed note (the exact test named in the review).
 *
 *   - admit: the member gains shared read (Vault membership) + a member-key private partition;
 *   - a live session unlocks that partition (the Warden can transiently RAG the member's content);
 *   - remove: the member is off the roster, their live session dies, AND the key they already unwrapped is
 *     zeroized at the same instant — the Warden can no longer decrypt their partition-sealed note.
 *
 * Live (needs the Archon node). Run:  npm run e2e:household-governance
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  sealToKey,
  sealForWarden,
  openWithKey,
  unwrapKey,
} from '@hearthold/core';
import { HouseholdVault } from '@hearthold/warden/household-vault';
import { admitMember, removeMember, shareToHousehold } from '@hearthold/warden/household';
import { VaultStore } from '@hearthold/warden/store';
import { ControlSessionStore } from '@hearthold/warden/control-session';
import { SessionKeyStore } from '@hearthold/warden/session-keys';
import type { HouseholdConfig } from '@hearthold/warden/household-config';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-household';

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass); // an admitted household member (contributor)
  const bob = await openKeymaster('verifier', config, pass); // NOT admitted (a non-contributor)
  const wardenId = await ensureIdentity(warden, config);
  const gov = wardenId.did; // (governor role tested in e2e-governor-overreach; here we exercise execution)
  const aliceDid = (await ensureIdentity(alice, config)).did;
  const bobDid = (await ensureIdentity(bob, config)).did;

  // Provision a household: a Warden-owned shared Vault + read/write rosters + config.
  const vault = await HouseholdVault.create(warden, config);
  const readGroup = await createRegistryGroup(warden, 'hh-read', config.registry);
  const writeGroup = await createRegistryGroup(warden, 'hh-write', config.registry);
  const household: HouseholdConfig = {
    householdId: 'home', sharedVaultDid: vault.did, governorDid: gov,
    readGroup, writeGroup, memberPartitions: true, governorObservesActivity: false,
  };

  process.stdout.write('\n▸ Admit — shared read + a member-key private partition\n');
  const partition = await admitMember(warden, config, household, aliceDid);
  assert(await vault.isMember(aliceDid), 'Alice is a member of the shared Vault (shared read)');
  assert(!!partition.partitionPub && !!partition.wrappedKey, 'Alice has a member-key private partition');

  // The Warden writes a private note to Alice's partition (write-host) — cannot read it at rest.
  const secret = 'alice private: custody hearing notes';
  const ct = sealToKey(warden.cipher, partition.partitionPub!, secret);

  process.stdout.write('\n▸ A live session unlocks Alice’s partition (read-guest active)\n');
  const sessions = new ControlSessionStore(30 * 60_000);
  const sessionKeys = new SessionKeyStore();
  const { token } = sessions.issue(aliceDid);
  // Alice unlocks (rewrap proven in e2e:partition-rewrap; here we place her unwrapped key directly).
  sessionKeys.put(token, partition.id, await unwrapKey(alice, partition.wrappedKey!));
  assert(sessions.resolve(token) === aliceDid, 'Alice has a live session');
  assert(openWithKey(warden.cipher, sessionKeys.get(token, partition.id)!, ct) === secret, 'the Warden can transiently RAG Alice’s content during her session');

  process.stdout.write('\n▸ Share-to-household — owner-only, contributor-tier, visible to all\n');
  const store = new VaultStore(warden.dataFolder);
  const seedNote = async (id: string, owner: string) =>
    store.put({ id, kind: 'document', observedAt: '2026-07-16T12:00:00Z', storedAt: '2026-07-16T12:00:00Z', sensitivity: 1, ciphertext: await sealForWarden(warden, wardenId.did, JSON.stringify({ text: `note ${id}` })), metadata: {}, owner, scope: 'private' });
  await seedNote('a-note', aliceDid);
  await seedNote('b-note', bobDid);
  const noStepUp = async () => true; // LOW items don't step up anyway
  const aShare = await shareToHousehold(warden, config, household, 'a-note', aliceDid, noStepUp);
  assert(aShare.shared, 'Alice (a contributor, via admit) shares her own note to the household');
  assert((await store.get('a-note'))?.scope === 'shared', 'the shared item is now scope:shared (every member sees it)');
  assert((await vault.read('a-note')) !== null, 'the plaintext is in the shared Vault (encrypted to all members)');
  const bobOwn = await shareToHousehold(warden, config, household, 'b-note', bobDid, noStepUp);
  assert(!bobOwn.shared && /read-only|contribut/.test(bobOwn.reason ?? ''), 'a non-contributor (read-only) member cannot share');
  const bobOnAlice = await shareToHousehold(warden, config, household, 'a-note', bobDid, noStepUp);
  assert(!bobOnAlice.shared, 'a non-owner cannot share someone else’s item (owner-only)');

  process.stdout.write('\n▸ Remove — decryption dies ON REMOVAL, not at TTL (watch-item #1)\n');
  const result = await removeMember(warden, config, household, aliceDid, sessions, sessionKeys);
  assert(result.revokedSessions === 1 && result.zeroizedKeys === 1, 'remove revoked Alice’s live session and zeroized 1 read-guest key');
  assert(!(await vault.isMember(aliceDid)), 'Alice is off the shared Vault roster');
  assert(sessions.resolve(token) === null, 'Alice’s session token is dead immediately');
  assert(sessionKeys.get(token, partition.id) === undefined, 'Alice’s already-unwrapped partition key is gone');

  let stillReadable = false;
  const gone = sessionKeys.get(token, partition.id);
  if (gone) { try { stillReadable = openWithKey(warden.cipher, gone, ct) === secret; } catch { stillReadable = false; } }
  assert(!stillReadable, 'the Warden can NO LONGER decrypt Alice’s partition note — decryption died on removal, not at TTL');

  process.stdout.write('\n✓ Household governance: admit grants shared+private; remove revokes AND kills live decryption at once\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-household-governance: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
