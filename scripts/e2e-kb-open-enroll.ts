/**
 * e2e: KB OPEN ENROLLMENT — a proven DID's first action auto-joins (zero-barrier onboarding for HATPro).
 *
 * Proves: on an `openEnrollment` KB, a fresh (un-granted) but AUTHENTICATED DID that contributes is
 * auto-admitted — granted read+write and given a private partition — and its write lands; a repeat is a no-op
 * (idempotent); `maxMembers` caps NEW members with a clear refusal (existing members keep acting); and with
 * open enrollment OFF the same fresh DID is refused "not authorized" (back-compat — grants stay a Sovereign's).
 * Only an authenticated DID enrolls (execute runs after signature verification), so no spoofed DID gets in.
 *
 *   HEARTHOLD_CLASSIFIER=quarantine HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-kb-open-enroll.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  selfSigner,
  signKbRequest,
  type KbRequestStatement,
} from '@hearthold/core';
import { KbConfigStore, initKbAssurance, buildKbServices } from '@hearthold/warden/kb-config';
import { PartitionStore } from '@hearthold/warden/partition-store';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);
const isResult = (r: unknown): boolean => (r as { type?: string }).type === 'hearthold/kb-result';
const errReason = (r: unknown): string => ((r as { type?: string; reason?: string }).type === 'hearthold/kb-error' ? ((r as { reason?: string }).reason ?? '') : '');

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-kb-open-enroll';
  const warden = await openKeymaster('warden', config, pass);
  const alice = await openKeymaster('sovereign', config, pass);
  const bob = await openKeymaster('verifier', config, pass);
  const carol = await openKeymaster('registry', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const aliceId = await ensureIdentity(alice, config);
  const bobId = await ensureIdentity(bob, config);
  const carolId = await ensureIdentity(carol, config);

  // An OPEN, capped, member-partition KB — NO members pre-granted (the point of open enrollment).
  const OPEN = 'hatpro-open';
  const readGroup = await createRegistryGroup(warden, `kb-read-${OPEN}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${OPEN}`, config.registry);
  const policyAsset = await initKbAssurance(warden, config, OPEN, selfSigner(warden, wardenId.did));
  const store = new KbConfigStore(warden.dataFolder);
  await store.put({ kbId: OPEN, readGroup, writeGroup, policyAsset, memberPartitions: true, defaultScope: 'private', openEnrollment: true, maxMembers: 2 });

  const partitions = new PartitionStore(warden.dataFolder);
  const svc = async (id: string) => (await buildKbServices(warden, config, wardenId.did)).get(id)!;
  const contribute = async (kbId: string, who: typeof alice, whoDid: string, text: string, scope: 'private' | 'shared' = 'private') => {
    const kb = await svc(kbId);
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(who, { action: 'update', requester: whoDid, kbId, nonce, kind: 'document', text, scope } as KbRequestStatement);
    return kb.serve(signed);
  };

  step('a fresh, un-granted DID auto-joins on its first contribution (grant + partition, write lands)');
  const a1 = await contribute(OPEN, alice, aliceId.did, 'alice profile');
  check('the write succeeds (auto-enrolled)', isResult(a1));
  check('Alice is now a write member (granted by open enrollment)', await warden.keymaster.testGroup(writeGroup, aliceId.did).catch(() => false));
  check('Alice got a private partition provisioned', !!(await partitions.get(OPEN, aliceId.did)));

  step('a repeat is idempotent — no double-grant, the write still lands');
  const a2 = await contribute(OPEN, alice, aliceId.did, 'alice profile v2');
  const g1 = (await warden.keymaster.getGroup(writeGroup)) as { members?: string[] };
  check('the second write lands', isResult(a2));
  check('Alice appears once in the write group (no duplicate enroll)', (g1.members ?? []).filter((m) => m === aliceId.did).length === 1);

  step('maxMembers caps NEW members — Bob fills the cap, Carol is refused (existing members keep acting)');
  check('Bob (2nd member) auto-enrolls', isResult(await contribute(OPEN, bob, bobId.did, 'bob profile')));
  const carolTry = await contribute(OPEN, carol, carolId.did, 'carol profile');
  check('Carol is refused with a clear "enrollment full" reason', /enrollment is full/i.test(errReason(carolTry)));
  check('Carol was NOT granted (cap held at 2)', !(await warden.keymaster.testGroup(writeGroup, carolId.did).catch(() => false)));
  check('an existing member still writes after the cap', isResult(await contribute(OPEN, alice, aliceId.did, 'alice again')));

  step('open enrollment OFF ⇒ a fresh DID is refused "not authorized" (grants stay a Sovereign’s) — back-compat');
  const CLOSED = 'hatpro-closed';
  const rG = await createRegistryGroup(warden, `kb-read-${CLOSED}`, config.registry);
  const wG = await createRegistryGroup(warden, `kb-write-${CLOSED}`, config.registry);
  const cPolicy = await initKbAssurance(warden, config, CLOSED, selfSigner(warden, wardenId.did));
  await store.put({ kbId: CLOSED, readGroup: rG, writeGroup: wG, policyAsset: cPolicy, memberPartitions: true, defaultScope: 'shared' });
  const closedTry = await contribute(CLOSED, carol, carolId.did, 'carol on a closed KB', 'shared');
  check('the closed KB refuses a non-member "not authorized" (not "enrollment full" — the classic path)', /not authorized/i.test(errReason(closedTry)) && !/enrollment/i.test(errReason(closedTry)));

  process.stdout.write(
    failures === 0
      ? '\n✓ kb-open-enroll: a proven DID auto-joins on first action (grant + partition), idempotent, capped; open-off stays invite-only\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-kb-open-enroll: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
