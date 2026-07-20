import { randomBytes } from 'node:crypto';

import {
  PROTOCOL_VERSION,
  generatePartitionKeypair,
  openWithKey,
  type HearthholdConfig,
  type KeymasterHandle,
  type CipherPrivateJwk,
  type PartitionRewrapRequestMessage,
} from '@hearthold/core';

import { PartitionStore } from './partition-store.js';
import type { SessionKeyStore } from './session-keys.js';

/** The seam the rewrap round-trip rides — satisfied by `DidCommTransport.request` (real Signet) or a mock. */
export interface RewrapChannel {
  request(targetDid: string, message: unknown, opts?: { timeoutMs?: number }): Promise<{ type?: string } & Record<string, unknown>>;
}

/**
 * The read-guest handshake (guardianship-threat-model §4a). Unlock a member's OWN private partitions for
 * their session: resolve the member's local partitions (scoped — never another member's, §4.1), mint an
 * EPHEMERAL Warden session keypair, ask the member's Signet to rewrap each partition key to it (the member
 * authorizes with their own proof-of-human; their long-term key never leaves the Signet), then store the
 * transient keys under the session token. Returns how many partitions were unlocked (0 if declined / none).
 * The ephemeral private key is discarded when this function returns — it has done its one job.
 */
export async function unlockSessionPartitions(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  channel: RewrapChannel,
  memberDid: string,
  sessionToken: string,
  sessionKeys: SessionKeyStore,
): Promise<number> {
  const owned = (await new PartitionStore(handle.dataFolder).listByOwner(memberDid)).filter(
    (p) => p.location.kind === 'local' && p.wrappedKey && p.partitionPub,
  );
  if (owned.length === 0) return 0;

  const wardenSession = generatePartitionKeypair(handle.cipher); // ephemeral, this call only
  const req: PartitionRewrapRequestMessage = {
    type: 'hearthold/partition-rewrap-request',
    version: PROTOCOL_VERSION,
    sessionId: sessionToken,
    wardenSessionPub: wardenSession.publicJwk,
    partitions: owned.map((p) => ({ partitionId: p.id, wrapped: p.wrappedKey as string })),
    nonce: randomBytes(16).toString('hex'),
  };

  const timeoutMs = config.stepUpTimeoutMs.factor1;
  const reply = await channel.request(memberDid, req, { timeoutMs });
  if (reply.type !== 'hearthold/partition-rewrap-response' || reply.approved !== true) return 0;

  const rewrapped = (reply.rewrapped as { partitionId: string; rewrapped: string }[] | undefined) ?? [];
  let unlocked = 0;
  for (const r of rewrapped) {
    try {
      const priv = JSON.parse(openWithKey(handle.cipher, wardenSession.privateJwk, r.rewrapped)) as CipherPrivateJwk;
      sessionKeys.put(sessionToken, r.partitionId, priv);
      unlocked++;
    } catch {
      /* a rewrapped entry the Warden's ephemeral key can't open — skip, don't fail the batch */
    }
  }
  return unlocked;
}
