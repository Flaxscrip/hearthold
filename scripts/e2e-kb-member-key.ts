/**
 * e2e: the member-key seal cutover (Phase 6). A member's PRIVATE-partition KB write is sealed to the
 * partition's PUBLIC key — the Warden writes it (write-host) but cannot open it at rest; only the member's
 * own session-rewrapped key reads it back (read-guest). This is the PVM-at-rest property finally live on
 * the path that mints the key.
 *
 * Proves, deterministically (no Ollama, no challenge/response login — which is environmentally flaky):
 *   - a private write lands sealed to the partition key (`sealedTo`), and `unsealAsWarden` FAILS on it
 *     (the Warden genuinely cannot read it at rest);
 *   - a SHARED write stays Warden-sealed (the cutover is scoped to private only);
 *   - after the member's own Signet rewraps their partition key for a session, that key opens the note
 *     (exactly the recall resolver's decrypt step — the same-session read);
 *   - another member never unlocks this partition (scoped — no key for it in their session);
 *   - a fresh session re-unlocks it (content is not lost across sessions);
 *   - the read-guest key dies on session zeroize.
 *
 * The write runs through the REAL KbService path (`kb.serve` → storeContribution → sealToKey); the rewrap
 * runs the REAL member Signet responder in-process (`makeSovereignHandler` + PinGate). Only the DIDComm
 * transport is an in-process call. Live (needs the Archon node for identities/partitions/groups).
 * Run:  npm run e2e:kb-member-key
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  grantAuthorization,
  selfSigner,
  signKbRequest,
  unsealAsWarden,
  openWithKey,
  type KbRequestStatement,
} from '@hearthold/core';
import { KbConfigStore, initKbAssurance, buildKbServices, provisionMemberPartition } from '@hearthold/warden/kb-config';
import { VaultStore } from '@hearthold/warden/store';
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
  const pass = 'hearthold-e2e-kb-member-key';
  const SPACE = 'family-kb-mk';
  const PIN = '2468';

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass); // member A, her own Signet
  const bob = await openKeymaster('verifier', config, pass); // member B (for scoping)
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const bobId = await ensureIdentity(bob, config);

  // Provision the space (member partitions on, default contribute = private) + grant both members.
  const readGroup = await createRegistryGroup(warden, `kb-read-${SPACE}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${SPACE}`, config.registry);
  for (const did of [aliceId.did, bobId.did]) {
    await grantAuthorization(warden, readGroup, did);
    await grantAuthorization(warden, writeGroup, did);
  }
  const policyAsset = await initKbAssurance(warden, config, SPACE, selfSigner(warden, wardenId.did));
  await new KbConfigStore(warden.dataFolder).put({ kbId: SPACE, readGroup, writeGroup, policyAsset, memberPartitions: true, defaultScope: 'private' });
  const alicePriv = await provisionMemberPartition(warden, config, SPACE, aliceId.did);
  await provisionMemberPartition(warden, config, SPACE, bobId.did);
  assert(!!alicePriv.partitionPub, 'Alice’s partition was minted with a public key (member-key write-host)');

  const kb = (await buildKbServices(warden, config, wardenId.did)).get(SPACE)!;
  const store = new VaultStore(warden.dataFolder);
  const contribute = async (who: typeof alice, whoDid: string, text: string, scope?: 'shared' | 'private') => {
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(who, { action: 'update', requester: whoDid, kbId: SPACE, nonce, kind: 'document', text, scope } as KbRequestStatement);
    return kb.serve(signed);
  };
  const idOf = (r: unknown): string => (r as { artefactId: string }).artefactId;

  process.stdout.write('\n▸ A private write is sealed to the partition key — the Warden can’t read it at rest\n');
  const secret = 'alice private: appointment Thursday 3pm';
  const pRes = await contribute(alice, aliceId.did, secret); // default = private
  const priv = await store.get(idOf(pRes));
  assert(priv?.sealedTo?.partition === alicePriv.id, 'the private note is marked sealedTo Alice’s partition');
  let wardenRead: string | null = null;
  try { wardenRead = await unsealAsWarden(warden, priv!.ciphertext); } catch { wardenRead = null; }
  assert(wardenRead === null, 'unsealAsWarden FAILS on it — the Warden genuinely cannot open it at rest');

  process.stdout.write('\n▸ A shared write stays Warden-sealed (the cutover is private-only)\n');
  const sRes = await contribute(alice, aliceId.did, 'family dinner Sunday', 'shared');
  const shared = await store.get(idOf(sRes));
  assert(!shared?.sealedTo, 'the shared note carries no sealedTo marker');
  assert((await unsealAsWarden(warden, shared!.ciphertext).catch(() => null)) !== null, 'the Warden opens the shared note (unchanged path)');

  // The channel = the REAL member Signet responder in-process (proof-of-human via PinGate).
  const signetOf = (h: typeof alice): RewrapChannel => {
    const handler = makeSovereignHandler(h, new PinGate(PIN, PIN));
    return { request: async (_target, msg) => (await handler(msg as never, wardenId.did)) as never };
  };
  const sessionKeys = new SessionKeyStore();

  process.stdout.write('\n▸ Alice’s session rewraps her key → she reads her own note (the resolver’s decrypt)\n');
  const aToken = 'sess-alice-1';
  const unlocked = await unlockSessionPartitions(warden, config, signetOf(alice), aliceId.did, aToken, sessionKeys);
  assert(unlocked === 1, 'Alice’s Signet rewrapped exactly her 1 partition key for the session');
  const aKey = sessionKeys.get(aToken, alicePriv.id);
  assert(!!aKey, 'the read-guest key for Alice’s partition is held for her session');
  assert((JSON.parse(openWithKey(warden.cipher, aKey!, priv!.ciphertext)) as { text: string }).text === secret, 'the session key opens Alice’s private note — the exact operation recall performs');

  process.stdout.write('\n▸ Another member never unlocks this partition (scoped)\n');
  const bToken = 'sess-bob-1';
  await unlockSessionPartitions(warden, config, signetOf(bob), bobId.did, bToken, sessionKeys);
  assert(sessionKeys.get(bToken, alicePriv.id) === undefined, 'Bob’s session holds NO key for Alice’s partition — his unlock is scoped to his own');

  process.stdout.write('\n▸ A fresh session re-unlocks it (content is not lost across sessions)\n');
  const aToken2 = 'sess-alice-2';
  await unlockSessionPartitions(warden, config, signetOf(alice), aliceId.did, aToken2, sessionKeys);
  const aKey2 = sessionKeys.get(aToken2, alicePriv.id);
  assert(!!aKey2 && (JSON.parse(openWithKey(warden.cipher, aKey2!, priv!.ciphertext)) as { text: string }).text === secret, 're-login re-unlocks — the note reads again from a new session');

  process.stdout.write('\n▸ The read-guest key dies on session zeroize\n');
  sessionKeys.zeroize(aToken);
  assert(sessionKeys.get(aToken, alicePriv.id) === undefined, 'zeroize drops Alice’s first-session key (decryption ends with the session, not at some later GC)');

  process.stdout.write('\n✓ Member-key cutover: private KB writes are write-host / read-guest — the Warden holds but cannot read at rest\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-member-key: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
