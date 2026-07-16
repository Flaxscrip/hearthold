import { grantAuthorization, revokeAuthorization, type HearthholdConfig, type KeymasterHandle } from '@hearthold/core';

import { HouseholdVault } from './household-vault.js';
import type { HouseholdConfig } from './household-config.js';
import { provisionMemberPartition } from './kb-config.js';
import type { PartitionRecord } from './partition-store.js';
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
