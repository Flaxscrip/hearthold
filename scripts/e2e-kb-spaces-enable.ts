/**
 * e2e: enable KB Spaces on an ALREADY-provisioned plain shared KB (the `warden kb-spaces enable` path).
 *
 * Proves the retrofit is safe and complete: a KB provisioned WITHOUT member partitions, with members and
 * shared content already in it, can have spaces turned on afterwards — `enableMemberPartitions` flips the
 * flag, sets the default scope, and backfills a private partition for every current member (read ∪ write).
 * Existing shared content is untouched and still recalls; a member's later scope-less contribution now
 * lands in their private partition; re-running is idempotent (partition ids stable, no duplicates).
 *
 * Live (needs the Archon node for identities/groups). Run:  npm run e2e:kb-spaces-enable
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  grantAuthorization,
  selfSigner,
  signKbRequest,
  rankByQuery,
  type KbRequestStatement,
  type IndexEntry,
} from '@hearthold/core';
import { KbConfigStore, initKbAssurance, buildKbServices, enableMemberPartitions } from '@hearthold/warden/kb-config';
import { PartitionStore } from '@hearthold/warden/partition-store';
import { VaultStore } from '@hearthold/warden/store';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-kb-spaces-enable';
  const SPACE = 'shared-kb'; // generic: any group KB, not household-specific

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass);
  const bob = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const bobId = await ensureIdentity(bob, config);

  // ── Provision a PLAIN shared KB (no member partitions), grant Alice + Bob, add shared content. ──
  const readGroup = await createRegistryGroup(warden, `kb-read-${SPACE}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${SPACE}`, config.registry);
  for (const did of [aliceId.did, bobId.did]) {
    await grantAuthorization(warden, readGroup, did);
    await grantAuthorization(warden, writeGroup, did);
  }
  const policyAsset = await initKbAssurance(warden, config, SPACE, selfSigner(warden, wardenId.did));
  const store = new KbConfigStore(warden.dataFolder);
  await store.put({ kbId: SPACE, readGroup, writeGroup, policyAsset }); // ← no memberPartitions
  process.stdout.write(`plain shared KB "${SPACE}" provisioned (Alice + Bob, no partitions)\n`);

  const idOf = (r: unknown): string => (r as { artefactId: string }).artefactId;
  const svc0 = (await buildKbServices(warden, config, wardenId.did)).get(SPACE)!;
  const contribute = async (kb: typeof svc0, who: typeof alice, whoDid: string, text: string, scope?: 'shared' | 'private') => {
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(who, { action: 'update', requester: whoDid, kbId: SPACE, nonce, kind: 'document', text, scope } as KbRequestStatement);
    return kb.serve(signed);
  };

  process.stdout.write('\n▸ Pre-enable: a scope-less contribution lands in the shared partition\n');
  const preShared = await contribute(svc0, alice, aliceId.did, 'roster-2026');
  assert((preShared as { type: string }).type === 'hearthold/kb-result', 'pre-enable contribution succeeds');
  const cfg0 = (await store.get(SPACE))!;
  assert(!cfg0.memberPartitions, 'KB starts WITHOUT member partitions');
  {
    const vault = await new VaultStore(warden.dataFolder).list();
    const tag = vault.find((a) => a.id === idOf(preShared))?.metadata?.kb as string | undefined;
    assert(tag === SPACE, 'pre-enable content is in the SHARED partition');
  }

  process.stdout.write('\n▸ Enable spaces on the existing KB (backfills current members)\n');
  const result = await enableMemberPartitions(warden, config, store, cfg0, 'private');
  assert(result.alreadyOn === false, 'enable reports spaces were previously OFF');
  assert(result.members.length === 2 && result.members.includes(aliceId.did) && result.members.includes(bobId.did), 'backfill covers BOTH current members (read ∪ write, deduped)');

  const cfg1 = (await store.get(SPACE))!;
  assert(cfg1.memberPartitions === true, 'config now has member partitions ON');
  assert(cfg1.defaultScope === 'private', 'default scope was set to private');

  const pstore = new PartitionStore(warden.dataFolder);
  const alicePriv = await pstore.get(SPACE, aliceId.did);
  const bobPriv = await pstore.get(SPACE, bobId.did);
  assert(alicePriv !== null && bobPriv !== null, 'private partitions were backfilled for Alice AND Bob');

  process.stdout.write('\n▸ Pre-existing shared content is untouched by the retrofit\n');
  {
    const vault = await new VaultStore(warden.dataFolder).list();
    const tag = vault.find((a) => a.id === idOf(preShared))?.metadata?.kb as string | undefined;
    assert(tag === SPACE, "the shared note's partition tag is unchanged (still shared)");
  }

  process.stdout.write('\n▸ Post-enable: a scope-less contribution now lands in the private partition\n');
  const svc1 = (await buildKbServices(warden, config, wardenId.did)).get(SPACE)!; // rebuild — config changed
  const postPriv = await contribute(svc1, alice, aliceId.did, 'alice-note');
  assert((postPriv as { type: string }).type === 'hearthold/kb-result', 'post-enable contribution succeeds');
  {
    const vault = await new VaultStore(warden.dataFolder).list();
    const tag = vault.find((a) => a.id === idOf(postPriv))?.metadata?.kb as string | undefined;
    assert(tag === alicePriv!.id, "Alice's scope-less note now lands in HER private partition (new default)");
  }

  process.stdout.write('\n▸ Visible-set isolation holds after the retrofit\n');
  {
    const vault = await new VaultStore(warden.dataFolder).list();
    const entries: IndexEntry[] = vault.map((a) => ({ artefactId: a.id, kind: a.kind, observedAt: a.observedAt, sensitivity: a.sensitivity, embedding: [0, 0, 0], kb: a.metadata?.kb as string | undefined }));
    const seen = (visible: string[]): Set<string> => new Set(rankByQuery([0, 0, 0], entries, { k: 100, kb: visible }).map((s) => s.entry.artefactId));
    const aliceSees = seen([SPACE, alicePriv!.id]);
    const bobSees = seen([SPACE, bobPriv!.id]);
    assert(aliceSees.has(idOf(preShared)) && aliceSees.has(idOf(postPriv)), 'Alice sees the shared history + her new private note');
    assert(bobSees.has(idOf(preShared)) && !bobSees.has(idOf(postPriv)), "Bob sees the shared history but NOT Alice's private note");
  }

  process.stdout.write('\n▸ Re-running is idempotent (no duplicate partitions)\n');
  const again = await enableMemberPartitions(warden, config, store, (await store.get(SPACE))!, 'private');
  assert(again.alreadyOn === true, 're-run reports spaces were already ON');
  assert((await pstore.get(SPACE, aliceId.did))!.id === alicePriv!.id, "Alice's partition id is stable across re-run (no duplicate)");

  process.stdout.write('\n✓ KB Spaces retrofit: existing shared KB upgraded in place, content preserved, members backfilled\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-spaces-enable: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
