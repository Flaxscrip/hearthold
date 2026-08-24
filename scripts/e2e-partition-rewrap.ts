/**
 * e2e: the partition-key rewrap handshake — the read-guest half of write-host/read-guest
 * (guardianship-threat-model §4a; docs/phase2-rewrap-handshake-spec.md).
 *
 * Proves Fable's §4 acceptance criteria with the REAL Signet responder (`makeSovereignHandler`) run
 * in-process — only the DIDComm transport is mocked (an in-process call). The crypto and the responder
 * code path are real:
 *   - member-authorized: the member's own proof-of-human (PinGate) authorizes the rewrap;
 *   - Warden RAGs its own member's content: after unlock the Warden decrypts a partition-sealed note;
 *   - per-member routing: the request targets the SESSION member's Signet, not config.sovereignDid;
 *   - scoped: only the session member's partitions are unlocked, never another member's;
 *   - lifecycle zeroize: logout drops the key — the Warden can't decrypt after;
 *   - declined proof-of-human → nothing unlocked (a governor/wrong-PIN never obtains the key);
 *   - the read-guest key never persists to disk.
 *
 * Live (needs the Archon node for identities/partitions). Run:  npm run e2e:partition-rewrap
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, openKeymaster, ensureIdentity, sealToKey, openWithKey } from '@hearthold/core';
import { provisionMemberPartition } from '@hearthold/warden/kb-config';
import { SessionKeyStore } from '@hearthold/warden/session-keys';
import { unlockSessionPartitions, type RewrapChannel } from '@hearthold/warden/rewrap';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-rewrap';
  const PIN = '1379';

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass); // member A (her own Signet)
  const bob = await openKeymaster('verifier', config, pass); // member B (for scoping)
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const bobId = await ensureIdentity(bob, config);

  // Warden provisions private partitions → wraps each partition key to its member (Warden can't open at rest).
  const aPart = await provisionMemberPartition(warden, config, 'household', aliceId.did);
  const bPart = await provisionMemberPartition(warden, config, 'household', bobId.did);
  assert(!!aPart.partitionPub && !!aPart.wrappedKey, 'Alice partition minted with pub + member-wrapped key');

  // Warden WRITES a private note to Alice's partition pubkey — and cannot read it at rest.
  const secret = 'alice private: therapy Thursday 3pm';
  const ct = sealToKey(warden.cipher, aPart.partitionPub!, secret);

  // The channel = the REAL member Signet responder in-process (proof-of-human via PinGate). Capture target.
  let lastTarget: string | null = null;
  const signetOf = (h: typeof alice, pin: string): RewrapChannel => {
    const handler = makeSovereignHandler(h, new PinGate(PIN, pin));
    return { request: async (target, msg) => { lastTarget = target; return (await handler(msg as never, wardenId.did)) as never; } };
  };

  const keys = new SessionKeyStore();
  const token = 'sess-alice';

  process.stdout.write('\n▸ Unlock — the member authorizes; the Warden becomes a read-guest\n');
  const n = await unlockSessionPartitions(warden, config, signetOf(alice, PIN), aliceId.did, token, keys);
  assert(n === 1, 'member-authorized rewrap unlocked Alice’s 1 partition');
  assert(lastTarget === aliceId.did, 'rewrap routed to the SESSION member’s Signet (not config.sovereignDid)');

  process.stdout.write('\n▸ The Warden can now RAG Alice’s OWN private content\n');
  const priv = keys.get(token, aPart.id);
  assert(!!priv, 'Warden holds Alice’s transient partition key for the session');
  assert(openWithKey(warden.cipher, priv!, ct) === secret, 'Warden decrypts Alice’s private note with the session key');

  process.stdout.write('\n▸ Scoped — Bob’s partition is never unlocked in Alice’s session\n');
  assert(!keys.has(token, bPart.id), 'Bob’s partition key is absent from Alice’s session (scoped, §4.1)');

  process.stdout.write('\n▸ Lifecycle — zeroize on logout drops decryption immediately\n');
  const dropped = keys.zeroize(token);
  assert(dropped === 1, 'zeroize dropped Alice’s session key');
  assert(keys.get(token, aPart.id) === undefined, 'the Warden no longer holds the key — cannot RAG private content after');

  process.stdout.write('\n▸ Declined proof-of-human → nothing unlocked (governor / wrong PIN can’t obtain the key)\n');
  const keys2 = new SessionKeyStore();
  const n2 = await unlockSessionPartitions(warden, config, signetOf(alice, 'wrong'), aliceId.did, 'sess-2', keys2);
  assert(n2 === 0, 'wrong proof-of-human unlocks nothing — the key is never released');
  assert(keys2.get('sess-2', aPart.id) === undefined, 'no key held after a declined rewrap');

  process.stdout.write('\n▸ The read-guest key never touches disk\n');
  assert(!existsSync(join(warden.dataFolder, 'session-keys.json')), 'no session-key file — keys are in-memory only');

  process.stdout.write('\n✓ Rewrap handshake: member-authorized, scoped, per-member-routed, RAG-enabled, zeroized, disk-free\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-partition-rewrap: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
