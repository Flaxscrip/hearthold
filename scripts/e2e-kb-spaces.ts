/**
 * e2e: KB Spaces — a shared partition + a per-member private partition (docs/kb-spaces.md, Phase 1).
 *
 * Proves, deterministically (no Ollama dependency): a scope-less contribute lands in the member's PRIVATE
 * partition (the space default), an explicit `scope:'shared'` lands in the shared partition, a member
 * with no private partition is refused a private write, a non-member's query is refused before any recall,
 * and the visible-set filter isolates members — Alice's recall sees shared + her own private but never
 * Bob's, and vice-versa.
 *
 * Live (needs the Archon node for identities/groups). Run:  npm run e2e:kb-spaces
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
import { KbConfigStore, initKbAssurance, buildKbServices, provisionMemberPartition } from '@hearthold/warden/kb-config';
import { PartitionStore } from '@hearthold/warden/partition-store';
import { VaultStore } from '@hearthold/warden/store';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-kb-spaces';
  const SPACE = 'family-kb';

  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass);
  const bob = await openKeymaster('verifier', config, pass);
  const carol = await openKeymaster('registry', config, pass); // shared-only member (no private partition)
  const outsider = await openKeymaster('emissary', config, pass); // not a member at all
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const bobId = await ensureIdentity(bob, config);
  const carolId = await ensureIdentity(carol, config);
  const outsiderId = await ensureIdentity(outsider, config);

  // Provision the space: shared groups + policy, member partitions on, default contribute = private.
  const readGroup = await createRegistryGroup(warden, `kb-read-${SPACE}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${SPACE}`, config.registry);
  for (const did of [aliceId.did, bobId.did, carolId.did]) {
    await grantAuthorization(warden, readGroup, did);
    await grantAuthorization(warden, writeGroup, did);
  }
  const policyAsset = await initKbAssurance(warden, config, SPACE, selfSigner(warden, wardenId.did));
  await new KbConfigStore(warden.dataFolder).put({ kbId: SPACE, readGroup, writeGroup, policyAsset, memberPartitions: true, defaultScope: 'private' });

  // Auto-provision private partitions for Alice + Bob (Carol deliberately gets none).
  const alicePriv = await provisionMemberPartition(warden, config, SPACE, aliceId.did);
  const bobPriv = await provisionMemberPartition(warden, config, SPACE, bobId.did);
  process.stdout.write(`space "${SPACE}": shared + private partitions for Alice, Bob (Carol shared-only)\n`);

  const kb = (await buildKbServices(warden, config, wardenId.did)).get(SPACE)!;
  const contribute = async (who: typeof alice, whoDid: string, text: string, scope?: 'shared' | 'private') => {
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(who, { action: 'update', requester: whoDid, kbId: SPACE, nonce, kind: 'document', text, scope } as KbRequestStatement);
    return kb.serve(signed);
  };

  const idOf = (r: unknown): string => (r as { artefactId: string }).artefactId;

  process.stdout.write('\n▸ Contributions route by scope\n');
  const aPriv = await contribute(alice, aliceId.did, 'alice-secret');          // default = private
  const aShared = await contribute(alice, aliceId.did, 'family-dinner', 'shared');
  const bPriv = await contribute(bob, bobId.did, 'bob-secret');                // default = private
  assert([aPriv, aShared, bPriv].every((r) => (r as { type: string }).type === 'hearthold/kb-result'), 'all three contributions succeed');
  // The Warden's AUTHORITATIVE echo of where each write landed — the field the client renders its
  // success message from (never the button it clicked). A scope silently dropped on the wire (the
  // stale-relay bug) would surface here as a mismatch instead of a false "saved privately".
  const scopeOf = (r: unknown): string | undefined => (r as { scope?: string }).scope;
  assert(scopeOf(aPriv) === 'private', "Alice's scope-less update RESULT echoes scope:'private' (space default)");
  assert(scopeOf(aShared) === 'shared', "Alice's scope:'shared' update RESULT echoes scope:'shared'");
  assert(scopeOf(bPriv) === 'private', "Bob's scope-less update RESULT echoes scope:'private'");

  process.stdout.write('\n▸ A member with no private partition is refused a private write\n');
  const carolPriv = await contribute(carol, carolId.did, 'carol-try'); // default = private, but Carol has none
  assert((carolPriv as { type: string; reason?: string }).type === 'hearthold/kb-error', 'Carol (shared-only) is refused a private contribution');
  const carolShared = await contribute(carol, carolId.did, 'carol-shared', 'shared');
  assert((carolShared as { type: string }).type === 'hearthold/kb-result', 'Carol can still contribute to the shared partition');
  assert(scopeOf(carolShared) === 'shared', "Carol's shared update RESULT echoes scope:'shared'");

  // Snapshot the vault AFTER all contributes — the partition tag is metadata.kb (deterministic).
  const vault = await new VaultStore(warden.dataFolder).list();
  const kbTag = (artefactId: string): string | undefined => vault.find((a) => a.id === artefactId)?.metadata?.kb as string | undefined;
  assert(kbTag(idOf(aPriv)) === alicePriv.id, "Alice's scope-less note landed in HER private partition (space default)");
  assert(kbTag(idOf(aShared)) === SPACE, "Alice's scope:'shared' note landed in the shared partition");
  assert(kbTag(idOf(bPriv)) === bobPriv.id, "Bob's scope-less note landed in HIS private partition");

  process.stdout.write('\n▸ Visible-set isolation (union-recall filter)\n');
  // Build index entries from the vault artefacts (kb tag = partition); dummy embeddings — we test the
  // FILTER, not the ranking, so isolation is deterministic without Ollama.
  const entries: IndexEntry[] = vault.map((a) => ({ artefactId: a.id, kind: a.kind, observedAt: a.observedAt, sensitivity: a.sensitivity, embedding: [0, 0, 0], kb: a.metadata?.kb as string | undefined }));
  const visibleTo = (privId: string): string[] => [SPACE, privId];
  const seen = (visible: string[]): Set<string> => new Set(rankByQuery([0, 0, 0], entries, { k: 100, kb: visible }).map((s) => s.entry.artefactId));

  const aliceSees = seen(visibleTo(alicePriv.id));
  const bobSees = seen(visibleTo(bobPriv.id));
  assert(aliceSees.has(idOf(aPriv)) && aliceSees.has(idOf(aShared)) && aliceSees.has(idOf(carolShared)), 'Alice sees her private + the shared partition');
  assert(!aliceSees.has(idOf(bPriv)), "Alice does NOT see Bob's private note");
  assert(bobSees.has(idOf(bPriv)) && bobSees.has(idOf(aShared)), 'Bob sees his private + the shared partition');
  assert(!bobSees.has(idOf(aPriv)), "Bob does NOT see Alice's private note");

  process.stdout.write('\n▸ A non-member query is refused before any recall\n');
  const q = kb.challenge().nonce;
  const outQ = await kb.serve(await signInvalid(outsider, outsiderId.did, SPACE, q));
  assert((outQ as { type: string; reason?: string }).type === 'hearthold/kb-error' && /not authorized/.test((outQ as { reason?: string }).reason ?? ''), 'an outsider gets "not authorized" (no recall, no leak)');

  // Sanity: partitions are recorded Warden-side, keyed by (space, owner).
  const pstore = new PartitionStore(warden.dataFolder);
  assert((await pstore.get(SPACE, aliceId.did))?.id === alicePriv.id, 'partition store maps (space, owner) → partition');
  assert((await pstore.get(SPACE, carolId.did)) === null, 'Carol has no private partition recorded');

  process.stdout.write('\n✓ KB Spaces Phase 1: shared + per-member private partitions, isolated + scoped\n');
  process.exit(0);
}

/** Sign a query request (used for the outsider — authorization is refused before recall). */
async function signInvalid(who: Awaited<ReturnType<typeof openKeymaster>>, whoDid: string, kbId: string, nonce: string) {
  return signKbRequest(who, { action: 'query', requester: whoDid, kbId, nonce, query: 'anything' } as KbRequestStatement);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-spaces: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
