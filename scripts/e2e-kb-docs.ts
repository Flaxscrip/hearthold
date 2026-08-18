/**
 * e2e: KB structured documents — put-doc / get-doc (overwrite semantics for a Blazon profile).
 *
 * Proves the primitive that makes a Sovereign's Blazon coherent:
 *   - put-doc OVERWRITES — a re-write of the same docKey supersedes the prior version (superseded:1),
 *     so the store holds ONE current value, not an append-log;
 *   - get-doc reads the CURRENT value directly (not a RAG answer);
 *   - the SHARED copy (the Blazon) is readable by another member keyed by owner;
 *   - the PRIVATE copy is NEVER reachable by another member (the visible-set invariant);
 *   - an absent document reads back as text:null (a clean empty state, not "nothing indexed").
 *
 * Live (needs the Archon node for identities/groups; Ollama for the real classifier). Run:
 *   npm run e2e:kb-docs
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  grantAuthorization,
  selfSigner,
  signKbRequest,
  type KbRequestStatement,
  type KbResultMessage,
} from '@hearthold/core';
import { KbConfigStore, initKbAssurance, buildKbServices, provisionMemberPartition } from '@hearthold/warden/kb-config';
import { VaultStore } from '@hearthold/warden/store';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-kb-docs';
  const SPACE = 'blazon-kb';

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass); // the Blazon owner
  const bob = await openKeymaster('verifier', config, pass); // another member (a "querier")
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const bobId = await ensureIdentity(bob, config);

  // Provision the space: shared read/write groups + policy, member partitions on, default = private.
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

  const kb = (await buildKbServices(warden, config, wardenId.did)).get(SPACE)!;
  const store = new VaultStore(warden.dataFolder);

  const putDoc = async (who: typeof alice, whoDid: string, docKey: string, text: string, scope: 'private' | 'shared'): Promise<KbResultMessage> => {
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(who, { action: 'put-doc', requester: whoDid, kbId: SPACE, nonce, kind: 'document', text, scope, docKey } as KbRequestStatement);
    return kb.serve(signed);
  };
  const getDoc = async (who: typeof alice, whoDid: string, docKey: string, owner?: string): Promise<KbResultMessage> => {
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(who, { action: 'get-doc', requester: whoDid, kbId: SPACE, nonce, docKey, owner } as KbRequestStatement);
    return kb.serve(signed);
  };
  const docsIn = async (kbTag: string, contributor: string, docKey: string): Promise<number> =>
    (await store.list()).filter((a) => a.metadata?.kb === kbTag && a.metadata?.contributor === contributor && a.metadata?.docKey === docKey).length;
  const sup = (r: KbResultMessage): number => (r as { superseded: number }).superseded;
  const txt = (r: KbResultMessage): string | null => (r as { text: string | null }).text;

  const PROFILE_V1 = JSON.stringify({ name: 'Alice', seat: 'window', diet: 'vegetarian' });
  const PROFILE_V2 = JSON.stringify({ name: 'Alice', seat: 'aisle', diet: 'vegan' });
  const BLAZON_V1 = JSON.stringify({ name: 'Alice', loyalty: 'silver' });
  const BLAZON_V2 = JSON.stringify({ name: 'Alice', loyalty: 'gold' });

  process.stdout.write('\n▸ put-doc OVERWRITES (private profile)\n');
  const p1 = await putDoc(alice, aliceId.did, 'profile', PROFILE_V1, 'private');
  assert((p1 as { action?: string }).action === 'put-doc' && sup(p1) === 0, 'first put-doc: superseded 0 (a fresh document)');
  const p2 = await putDoc(alice, aliceId.did, 'profile', PROFILE_V2, 'private');
  assert(sup(p2) === 1, 're-put of the same docKey: superseded 1 (the prior version was replaced)');
  assert((await docsIn(alicePriv.id, aliceId.did, 'profile')) === 1, "the store holds exactly ONE 'profile' doc for Alice (not an append-log)");

  process.stdout.write('\n▸ a PRIVATE document is never reachable by another member\n');
  const bobReadsPrivate = await getDoc(bob, bobId.did, 'profile', aliceId.did);
  assert((bobReadsPrivate as { action?: string }).action === 'get-doc' && txt(bobReadsPrivate) === null, "Bob's get-doc of Alice's profile is null — her PRIVATE partition is not reachable");

  process.stdout.write('\n▸ Blazon: publish to shared, then another member reads the CURRENT value\n');
  const s1 = await putDoc(alice, aliceId.did, 'profile', BLAZON_V1, 'shared');
  assert(sup(s1) === 0, 'first shared put-doc: superseded 0 (the shared doc is separate from the private one)');
  const s2 = await putDoc(alice, aliceId.did, 'profile', BLAZON_V2, 'shared');
  assert(sup(s2) === 1, 're-publish overwrites the shared Blazon: superseded 1');
  assert((await docsIn(SPACE, aliceId.did, 'profile')) === 1, "exactly ONE shared 'profile' (Blazon) doc for Alice");
  const bobReadsBlazon = await getDoc(bob, bobId.did, 'profile', aliceId.did);
  assert(txt(bobReadsBlazon) === BLAZON_V2 && (bobReadsBlazon as { scope?: string }).scope === 'shared', "Bob reads Alice's Blazon = the CURRENT shared value (not v1, not her private profile)");
  assert(txt(bobReadsBlazon) !== PROFILE_V2, "Bob's shared read never returns Alice's PRIVATE profile value");

  process.stdout.write('\n▸ an absent document is a clean empty state\n');
  const missing = await getDoc(bob, bobId.did, 'no-such-doc', aliceId.did);
  assert(txt(missing) === null, "get-doc of a non-existent docKey returns text:null (not an error, not stale data)");

  process.stdout.write('\n✓ KB structured documents: put-doc overwrite + get-doc coherent read + invariant preserved\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-docs: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
