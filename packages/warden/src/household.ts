import { grantAuthorization, revokeAuthorization, unsealAsWarden, Sensitivity, type HearthholdConfig, type KeymasterHandle } from '@hearthold/core';

import { HouseholdVault } from './household-vault.js';
import type { HouseholdConfig } from './household-config.js';
import { provisionMemberPartition } from './kb-config.js';
import type { PartitionRecord } from './partition-store.js';
import { VaultStore } from './store.js';
import { IndexStore } from './index-store.js';
import type { ControlSessionStore } from './control-session.js';
import type { SessionKeyStore } from './session-keys.js';

/**
 * Household admit/remove — the Warden EXECUTES membership changes the Master-Sovereign has authorized
 * (its Signet proof-of-human at the call site; PVM: the governor authorizes, the Warden executes and
 * custodies). Built on the shipped primitives (HouseholdVault, the read/write groups, member-key
 * partitions), so nothing new is invented here.
 */

/**
 * Admit a member: shared READ (Vault membership), the private-side roster (read+write groups), and a
 * member-key private partition. Idempotent. Returns the member's private partition.
 */
export async function admitMember(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  household: HouseholdConfig,
  memberDid: string,
): Promise<PartitionRecord> {
  const vault = new HouseholdVault(handle, household.sharedVaultDid);
  await vault.admit(memberDid); // shared read (decrypt) on invite
  await grantAuthorization(handle, household.readGroup, memberDid);
  await grantAuthorization(handle, household.writeGroup, memberDid);
  return provisionMemberPartition(handle, config, household.householdId, memberDid); // private partition (member-key)
}

/**
 * Remove a member: revoke shared read + the roster, AND — the cross-phase invariant
 * (guardianship-threat-model §4.3, Fable watch-item #1) — **zeroize their already-unwrapped read-guest
 * keys immediately**. A removed member's live session dies AND loses its ability to decrypt at the same
 * instant, not at TTL. Their private partition content is RETAINED under their own ownership (removal is
 * not destruction; deletion is a separate, explicit act).
 */
export async function removeMember(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  household: HouseholdConfig,
  memberDid: string,
  sessions: ControlSessionStore,
  sessionKeys: SessionKeyStore,
): Promise<{ revokedSessions: number; zeroizedKeys: number }> {
  const vault = new HouseholdVault(handle, household.sharedVaultDid);
  await vault.remove(memberDid); // revoke shared read
  await revokeAuthorization(handle, household.readGroup, memberDid);
  await revokeAuthorization(handle, household.writeGroup, memberDid);
  // Kill decryption on removal, not at TTL: revoke the member's live sessions, then zeroize the partition
  // keys those sessions had already unwrapped.
  const revoked = sessions.revokeAllFor(memberDid);
  let zeroizedKeys = 0;
  for (const token of revoked) zeroizedKeys += sessionKeys.zeroize(token);
  return { revokedSessions: revoked.length, zeroizedKeys };
}

/**
 * Share-to-household: promote a member's OWN artefact into the shared pool. Only the owner may share their
 * own item; only a CONTRIBUTOR (a household writer, not a read-only member) may write shared; and the item
 * pays its own sensitivity's step-up (Fable addition 2 — sharing to N members costs what the item costs).
 * On success the plaintext is put into the shared Archon Vault (encrypted to every member) and the item is
 * marked `scope: 'shared'` in the vault + recall index so every member sees it.
 */
export async function shareToHousehold(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  household: HouseholdConfig,
  artefactId: string,
  memberDid: string,
  stepUp: (sensitivity: number) => Promise<boolean>,
): Promise<{ shared: boolean; reason?: string }> {
  const store = new VaultStore(handle.dataFolder);
  const a = await store.get(artefactId);
  if (!a) return { shared: false, reason: 'no such artefact' };
  if ((a.owner ?? config.sovereignDid) !== memberDid) return { shared: false, reason: 'only the owner may share their own item' };
  if (a.scope === 'shared') return { shared: true }; // idempotent
  const isContributor = await handle.keymaster.testGroup(household.writeGroup, memberDid).catch(() => false);
  if (!isContributor) return { shared: false, reason: 'read-only member — not permitted to contribute to the household' };
  if (a.sensitivity >= Sensitivity.MEDIUM && !(await stepUp(a.sensitivity))) {
    return { shared: false, reason: 'the step-up for this item’s sensitivity was declined' };
  }
  const plaintext = await unsealAsWarden(handle, a.ciphertext);
  await new HouseholdVault(handle, household.sharedVaultDid).share(artefactId, plaintext); // encrypted to all members
  await store.put({ ...a, scope: 'shared' }); // visible to every member (snapshot / visibleTo)
  const index = new IndexStore(handle.dataFolder); // flip recall to shared too
  const entry = (await index.list()).find((e) => e.artefactId === artefactId);
  if (entry) await index.put({ ...entry, scope: 'shared' });
  return { shared: true };
}
