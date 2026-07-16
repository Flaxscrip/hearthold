/**
 * e2e: guardianship (Phase 5 / guardianship-threat-model.md §5, §7). A governor may lawfully read a
 * member's private data — but only through an active, member-ACKNOWLEDGED guardianship edge, within its
 * scope, unexpired, and every read is receipted to the watched member.
 *
 *   - unacknowledged guardianship → reads refused (the amendment rule, at read time);
 *   - acknowledged → the governor reads only within {kinds, ceiling}; out-of-kind and over-ceiling refused;
 *   - every allowed read → a receipt the member can see (evidence pointed inward);
 *   - the member can see the active edge (conspicuous, never covert);
 *   - expiry and emancipation (a signed revoke supersession) both cut access off.
 *
 * Live (needs the Archon node for signing/verification). Run:  npm run e2e:guardianship
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  sealForWarden,
  signRuleset,
  signMemberAck,
  operativeRuleset,
  rulesetId,
  Sensitivity,
  type Ruleset,
  type SignedRuleset,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { guardianRead, GuardianReceiptStore, GuardianshipStore, activeGuardianships } from '@hearthold/warden/guardianship';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

const AT = '2026-07-16T12:00:00Z';
const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-guardianship';

  const warden = await openKeymaster('warden', config, pass);
  const governor = await openKeymaster('sovereign', config, pass); // the guardian (e.g. a parent)
  const member = await openKeymaster('verifier', config, pass); // the watched member M
  const wardenId = await ensureIdentity(warden, config);
  const gov = (await ensureIdentity(governor, config)).did;
  const M = (await ensureIdentity(member, config)).did;

  // Seed member M's vault (all owned by M, sealed to the Warden).
  const store = new VaultStore(warden.dataFolder);
  const seed = async (id: string, kind: string, sensitivity: number, owner: string) =>
    store.put({ id, kind: kind as never, observedAt: AT, storedAt: AT, sensitivity, ciphertext: await sealForWarden(warden, wardenId.did, JSON.stringify({ text: `M ${id}` })), metadata: {}, owner, scope: 'private' });
  await seed('loc-low', 'location', Sensitivity.LOW, M);
  await seed('loc-high', 'location', Sensitivity.HIGH, M);
  await seed('doc', 'document', Sensitivity.LOW, M);
  await seed('other', 'location', Sensitivity.LOW, gov); // not M's

  // A guardianship edge: governor may read M's LOCATION up to MEDIUM. Signed by the governor.
  const edge = (validUntil: string, ceiling: number): Ruleset => ({
    actor: gov, actorKind: 'guardianship', resource: `guard:${M}`, version: 1, previous: null,
    capabilities: { kinds: ['location'], verbs: ['read'] }, ceiling, status: 'active', subject: M, validUntil,
  });
  const read = (chain: SignedRuleset[], id: string) => guardianRead(warden, config, chain, gov, M, id, AT);

  process.stdout.write('\n▸ Unacknowledged guardianship → refused (the amendment rule, at read time)\n');
  const unacked = [await signRuleset(governor, edge(FUTURE, Sensitivity.MEDIUM))]; // governor alone, no M ack
  assert(!(await read(unacked, 'loc-low')).granted, 'a guardianship M never acknowledged authorizes nothing');

  process.stdout.write('\n▸ Acknowledged guardianship → the governor reads within scope\n');
  const v1 = await signRuleset(governor, edge(FUTURE, Sensitivity.MEDIUM));
  const acked: SignedRuleset[] = [{ ...v1, memberAck: await signMemberAck(member, v1) }];
  const okRead = await read(acked, 'loc-low');
  assert(okRead.granted && (okRead.face ?? '').includes('loc-low'), 'governor reads M’s in-scope LOW location note');
  assert(!(await read(acked, 'doc')).granted, 'a kind outside the guardianship (document) is refused');
  assert(!(await read(acked, 'loc-high')).granted, 'a sensitivity over the guardianship ceiling (HIGH > MEDIUM) is refused');
  assert(!(await read(acked, 'other')).granted, 'an artefact that is not M’s is refused (uniform, no existence leak)');

  process.stdout.write('\n▸ Every allowed read is receipted to the member (the watched sees the watching)\n');
  const receipts = await new GuardianReceiptStore(warden.dataFolder).forSubject(M);
  assert(receipts.length === 1 && receipts[0]?.guardian === gov && receipts[0]?.artefactId === 'loc-low', 'exactly one receipt to M — governor read loc-low');
  assert(receipts.every((r) => r.artefactId !== 'doc' && r.artefactId !== 'loc-high'), 'refused reads emit NO receipt (and revealed nothing)');

  process.stdout.write('\n▸ The member sees the active edge (conspicuous, never covert)\n');
  const activeOverM = await operativeRuleset(warden, acked, { expectedSigner: gov });
  assert(activeOverM?.subject === M && activeOverM?.actor === gov, 'M can see WHO watches them (governor) and the scope (location ≤ MEDIUM)');

  process.stdout.write('\n▸ Expiry and emancipation both cut access off\n');
  const expiredV1 = await signRuleset(governor, edge(PAST, Sensitivity.MEDIUM));
  const expiredChain: SignedRuleset[] = [{ ...expiredV1, memberAck: await signMemberAck(member, expiredV1) }];
  assert(!(await read(expiredChain, 'loc-low')).granted, 'an EXPIRED guardianship is refused');
  const revoke = await signRuleset(governor, { ...edge(FUTURE, Sensitivity.MEDIUM), version: 2, previous: rulesetId(acked[0] as SignedRuleset), status: 'revoked' });
  const emancipated: SignedRuleset[] = [acked[0] as SignedRuleset, revoke]; // revoke is self-restricting → no ack needed
  assert(!(await read(emancipated, 'loc-low')).granted, 'emancipation (a signed revoke supersession) cuts access off');

  process.stdout.write('\n▸ Same-subject widening still needs the member (Fable review — no silent seizure)\n');
  const NEAR = '2026-08-01T00:00:00Z'; // the window M actually consented to
  const BETWEEN = '2026-09-01T00:00:00Z'; // past the acked window, before the attempted extension
  const g1 = await signRuleset(governor, edge(NEAR, Sensitivity.MEDIUM));
  const g1acked: SignedRuleset = { ...g1, memberAck: await signMemberAck(member, g1) };
  // The governor ALONE tries to stretch validUntil to FUTURE — no new kind, no higher ceiling. This slipped
  // through the old enumeration; under the inverted default it is access-widening and needs M's ack.
  const extendUnacked = await signRuleset(governor, { ...edge(FUTURE, Sensitivity.MEDIUM), version: 2, previous: rulesetId(g1acked) });
  const seizeWindow: SignedRuleset[] = [g1acked, extendUnacked];
  const opHead = await operativeRuleset(warden, seizeWindow, { expectedSigner: gov });
  assert(opHead?.validUntil === NEAR, 'a governor-alone validUntil EXTENSION is refused — the operative head stays the acked window');
  assert(!(await guardianRead(warden, config, seizeWindow, gov, M, 'loc-low', BETWEEN)).granted, 'a read past the ACKED window is refused, though the seized v2 would have allowed it');
  // Same class: a governor-alone ADDED VERB (slipping in `write`) is also access-widening.
  const addVerbUnacked = await signRuleset(governor, { ...edge(NEAR, Sensitivity.MEDIUM), version: 2, previous: rulesetId(g1acked), capabilities: { kinds: ['location'], verbs: ['read', 'write'] } });
  const opHead2 = await operativeRuleset(warden, [g1acked, addVerbUnacked], { expectedSigner: gov });
  assert(!(opHead2?.capabilities.verbs ?? []).includes('write'), 'a governor-alone ADDED VERB is refused — the operative head stays read-only');
  // And the SAME extension WITH M's ack is accepted — grantable, with consent (never seizable without it).
  const extendAcked: SignedRuleset = { ...extendUnacked, memberAck: await signMemberAck(member, extendUnacked) };
  const opHead3 = await operativeRuleset(warden, [g1acked, extendAcked], { expectedSigner: gov });
  assert(opHead3?.validUntil === FUTURE, 'the same window extension WITH M’s ack is accepted (grantable, with consent)');

  process.stdout.write('\n▸ The store surfaces active edges to the watched, and drops them on revoke\n');
  const gs = new GuardianshipStore(warden.dataFolder);
  await gs.replaceChain(gov, M, acked); // persist the acknowledged edge
  const watched = await activeGuardianships(warden, gs, M);
  assert(watched.length === 1 && watched[0]?.governor === gov && (watched[0]?.kinds ?? []).includes('location'), 'M’s "who watches me" surface shows the active edge + its scope');
  assert((await gs.forGovernor(gov)).some((e) => e.subject === M), 'the governor’s "what I watch" surface lists M');
  await gs.replaceChain(gov, M, emancipated); // the revoke supersession
  assert((await activeGuardianships(warden, gs, M)).length === 0, 'after emancipation the edge disappears from M’s surface (nothing watches them)');

  process.stdout.write('\n✓ Guardianship: acknowledged, scoped, receipted, conspicuous, expiring — grantable, never seizable\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-guardianship: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
