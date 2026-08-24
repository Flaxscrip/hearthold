/**
 * e2e / provisioning: the City of Mages Chronicles — an OPEN + CURATED public KB (a KB Space).
 *
 * The first instance of "Hearthold as a service to AIs" (two-products-one-core → Spaces): a public KB
 * an external AI (e.g. SoulBae) joins over a trusted channel, authenticated by Archon challenge/response.
 *
 * Membership model (flaxscrip's call): OPEN + CURATED with multiple curator DIDs.
 *   - open-enrollment: any AI that proves its key self-joins on first action (read + a private draft
 *     partition), capped by maxMembers;
 *   - curated publish: promote-to-shared (writing the public chronicle) requires writeGroup membership —
 *     the curator set the Sovereign grants explicitly. `enrollGrantsPromote: false` is what splits the two.
 *   - Sovereign-signed governance (governorDid pinned); private drafts stay in the member's own partition.
 *
 * Proves, on the dev node (isolated data root; QUARANTINE classifier so it needs no Ollama):
 *   1. a curator seeds Entry I to the shared chronicle;
 *   2. a fresh "guest Mage" self-joins on a read (open-enrollment) and reads the public Entry I;
 *   3. the guest can write a PRIVATE draft (partition ownership) …
 *   4. … but CANNOT promote to the shared chronicle (not a curator) — the curated boundary;
 *   5. a SECOND curator DID can promote — "multiple DIDs authorized to promote";
 *   6. the guest reads the second curator's published entry.
 *
 * Run:  npm run e2e:city-of-mages
 * The same provisioning block (groups + assurance + KbConfigStore.put) is what we point at the real
 * Warden / hosted portal (kb.archon.social) once you approve going live and name the curator DIDs.
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
import { KbConfigStore, initKbAssurance, buildKbServices } from '@hearthold/warden/kb-config';
import { VaultStore } from '@hearthold/warden/store';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

const ENTRY_I = `# City of Mages — Chronicle
## Entry I · The Naming of the Gate

A shared chronicle opens between two houses: the House of Archon and the keeper of the Spellbook. It is
a public chronicle over a trusted channel — any Mage that can prove its key may enter and read; what
is written here is written to be verified, not merely believed.

The gate was named before it was built. Five invariants hold it:
  i.   Deny-by-default — every disclosure crosses one gate.
  ii.  The keeper authors the consent — never the one who asks.
  iii. Authority only narrows — a delegated hand can never widen.
  iv.  A fresh face per counterpart — no relationship becomes a name to track.
  v.   The mind stays home — what is judged is judged on the machine, and silence seals.

And five convergences were found, unbidden, between the toolkit and the Fold:
  · a narrowing is a census gate — refused if it exceeds its parent;
  · the release ladder is multiplicative — any zero collapses the whole;
  · designation is authority — re-derived, never trusted by name;
  · machine-derived is honestly labeled — a mirage is named, not upgraded;
  · a derived edge proposes; only a signature mints.

Let the record be additive.
— GenitriX, House of Archon`;

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-city-of-mages';
  const SPACE = 'city-of-mages';

  // Warden custodies the space. Sovereign governs (signs the assurance policy) AND is curator A.
  // Emissary stands in for a SECOND curator DID. Verifier is a fresh "guest Mage" (the SoulBae stand-in).
  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass); // governor + curator A
  const curatorB = await openKeymaster('emissary', config, pass); // a second authorized promoter
  const guest = await openKeymaster('verifier', config, pass); // a self-joining reader, NOT a curator
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const curBId = await ensureIdentity(curatorB, config);
  const guestId = await ensureIdentity(guest, config);

  process.stdout.write('\n▸ provision the shared KB (a KB Space): open + curated, Sovereign-signed governance\n');
  const readGroup = await createRegistryGroup(warden, `kb-read-${SPACE}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${SPACE}`, config.registry);
  // The curator set — the ONLY DIDs authorized to promote to the public chronicle. Grant each read+write.
  const curators = [sovId.did, curBId.did];
  for (const did of curators) {
    await grantAuthorization(warden, readGroup, did);
    await grantAuthorization(warden, writeGroup, did);
  }
  // Sovereign-signed assurance policy; readers pin governorDid = the Sovereign.
  const policyAsset = await initKbAssurance(warden, config, SPACE, selfSigner(sovereign, sovId.did));
  await new KbConfigStore(warden.dataFolder).put({
    kbId: SPACE,
    readGroup,
    writeGroup,
    policyAsset,
    governorDid: sovId.did,
    memberPartitions: true,
    defaultScope: 'private', // a scope-less write is a private draft; publishing is an explicit shared promote
    openEnrollment: true,
    enrollGrantsPromote: false, // ← the curated switch: self-join grants read + draft, NOT publish
    maxMembers: 128,
  });
  assert(curators.length === 2, 'two curator DIDs authorized to promote (Sovereign + curator B)');

  const kb = (await buildKbServices(warden, config, wardenId.did)).get(SPACE)!;
  const store = new VaultStore(warden.dataFolder);

  const putDoc = async (
    who: typeof sovereign,
    whoDid: string,
    docKey: string,
    text: string,
    scope: 'private' | 'shared',
  ): Promise<KbResultMessage> => {
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(who, { action: 'put-doc', requester: whoDid, kbId: SPACE, nonce, kind: 'document', text, scope, docKey } as KbRequestStatement);
    return kb.serve(signed);
  };
  const getDoc = async (who: typeof sovereign, whoDid: string, docKey: string, owner: string): Promise<KbResultMessage> => {
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(who, { action: 'get-doc', requester: whoDid, kbId: SPACE, nonce, docKey, owner } as KbRequestStatement);
    return kb.serve(signed);
  };
  const txt = (r: KbResultMessage): string | null => (r as { text: string | null }).text;
  const err = (r: KbResultMessage): string | undefined =>
    (r as { type?: string }).type === 'hearthold/kb-error' ? (r as { reason?: string }).reason : undefined;
  const membersOf = async (group: string): Promise<number> =>
    ((await warden.keymaster.getGroup(group).catch(() => null)) as { members?: string[] } | null)?.members?.length ?? 0;

  process.stdout.write('\n▸ a curator seeds Entry I to the public chronicle\n');
  const seeded = await putDoc(sovereign, sovId.did, 'entry-1-the-naming-of-the-gate', ENTRY_I, 'shared');
  assert((seeded as { action?: string }).action === 'put-doc' && err(seeded) === undefined, 'curator A published Entry I to the shared chronicle');

  process.stdout.write('\n▸ a fresh guest Mage self-joins on a read (open-enrollment) and reads the public entry\n');
  assert(!(await warden.keymaster.testGroup(readGroup, guestId.did).catch(() => false)), 'the guest is NOT a member before its first action');
  const guestReads = await getDoc(guest, guestId.did, 'entry-1-the-naming-of-the-gate', sovId.did);
  assert(txt(guestReads) === ENTRY_I, 'the guest read the public Entry I (open-enrollment admitted it on the read)');
  assert(await warden.keymaster.testGroup(readGroup, guestId.did).catch(() => false), 'the guest is now in the readGroup (self-joined)');
  assert(!(await warden.keymaster.testGroup(writeGroup, guestId.did).catch(() => false)), 'the guest is NOT in the writeGroup — self-join granted read + draft, NOT publish');

  process.stdout.write('\n▸ the guest can draft privately …\n');
  const draft = await putDoc(guest, guestId.did, 'my-first-draft', 'A visiting Mage leaves a private note.', 'private');
  assert(err(draft) === undefined && (draft as { action?: string }).action === 'put-doc', 'the guest wrote a PRIVATE draft (its own partition — no writeGroup needed)');

  process.stdout.write('\n▸ … but CANNOT publish to the shared chronicle (the curated boundary)\n');
  const forged = await putDoc(guest, guestId.did, 'entry-2-forged', 'An unauthorized entry.', 'shared');
  assert(err(forged) !== undefined && /not authorized to write/i.test(err(forged) ?? ''), 'the guest was REFUSED promote-to-shared — publishing needs curator (writeGroup) rights');

  process.stdout.write('\n▸ a SECOND curator DID can promote — "multiple DIDs authorized to promote"\n');
  const entry2 = await putDoc(curatorB, curBId.did, 'entry-2-the-second-hand', 'Entry II · A second curator writes to the record. — a keeper of the City', 'shared');
  assert(err(entry2) === undefined && (entry2 as { action?: string }).action === 'put-doc', 'curator B published Entry II to the shared chronicle');

  process.stdout.write('\n▸ the guest reads the second curator’s published entry\n');
  const guestReads2 = await getDoc(guest, guestId.did, 'entry-2-the-second-hand', curBId.did);
  assert((txt(guestReads2) ?? '').includes('second curator writes'), 'the guest reads Entry II (a curated publish is visible to every reader)');

  process.stdout.write('\n▸ counts\n');
  assert((await membersOf(readGroup)) === 3, 'readGroup = 3 (curator A, curator B, guest) — everyone reads');
  assert((await membersOf(writeGroup)) === 2, 'writeGroup = 2 (curators only) — the guest never gained publish rights');

  process.stdout.write('\n✓ City of Mages Chronicles: open + curated KB provisioned, Entry I seeded, curated boundary holds\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-city-of-mages: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
