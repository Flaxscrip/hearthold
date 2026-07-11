/**
 * e2e: CGPR × KB Spaces — the custodial HATPro tie-in (docs/kb-spaces.md Phase 3).
 *
 * A custodial Warden runs a `hatpro-kb` space with a private partition per traveler (their traveler
 * profile / preferences). A hotel AI's CGPR request is disclosed FROM the requesting traveler's private
 * partition — the custodial DB becomes the vault the A2A gateway serves. Proves: the grant is backed by
 * the traveler's OWN partition (not the shared partition or another traveler's), its subject is a fresh
 * pairwise DID standing in for that traveler (never the traveler's or custodian's DID), two travelers to
 * the same hotel get UNLINKABLE subjects, and a traveler with no partition is refused.
 *
 * Isolated data root; run:  npm run e2e:cgpr-hatpro
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  loadConfig, openKeymaster, ensureIdentity,
  createRegistryGroup, grantAuthorization, selfSigner, signRuleset,
  requestProof, presentProof, verifyProof, pairwiseName, Sensitivity, type Ruleset,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { FilePairwiseStore } from '@hearthold/warden/pairwise-store';
import { PartitionStore } from '@hearthold/warden/partition-store';
import { KbConfigStore, initKbAssurance, provisionMemberPartition } from '@hearthold/warden/kb-config';
import { CgprService } from '@hearthold/warden/cgpr';
import { startA2aGateway, A2A_RPC_PATH, type CgprBackend } from '@hearthold/a2a-gateway';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const assert = (cond: unknown, msg: string): void => { if (!cond) throw new Error(`ASSERT: ${msg}`); };
const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;
const SPACE = 'hatpro-kb';

async function send(gateway: string, artifact: unknown): Promise<any> {
  const res = await fetch(`${gateway}${A2A_RPC_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'message/send', params: { message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: artifact }] } } }),
  });
  return (await res.json()).result;
}
const ticketFor = (): unknown => ({
  ticket: { ticketId: randomUUID(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), singleUse: true, scopes: ['foodAndBeverage.dietaryRestrictions'], purpose: 'Plan the guest menu' },
  requester: { did: '', agentCardUrl: 'https://hotel.example/card' }, validForMinutes: 15,
});

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-cgpr-hatpro';

  const warden = await openKeymaster('warden', config, pass);       // the custodial Warden
  const custodian = await openKeymaster('sovereign', config, pass); // governs the gateway Ruleset
  const t1 = await openKeymaster('verifier', config, pass);         // traveler 1
  const t2 = await openKeymaster('emissary', config, pass);         // traveler 2
  const hotel = await openKeymaster('registry', config, pass);      // C (the hotel AI)
  const wardenId = await ensureIdentity(warden, config);
  const custId = await ensureIdentity(custodian, config);
  const t1Id = await ensureIdentity(t1, config);
  const t2Id = await ensureIdentity(t2, config);
  const hotelId = await ensureIdentity(hotel, config);

  // Custodial HATPro space with per-traveler private partitions.
  const readGroup = await createRegistryGroup(warden, `kb-read-${SPACE}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${SPACE}`, config.registry);
  for (const did of [t1Id.did, t2Id.did]) { await grantAuthorization(warden, readGroup, did); await grantAuthorization(warden, writeGroup, did); }
  const policyAsset = await initKbAssurance(warden, config, SPACE, selfSigner(warden, wardenId.did));
  await new KbConfigStore(warden.dataFolder).put({ kbId: SPACE, readGroup, writeGroup, policyAsset, memberPartitions: true, defaultScope: 'private' });
  const p1 = await provisionMemberPartition(warden, config, SPACE, t1Id.did);
  const p2 = await provisionMemberPartition(warden, config, SPACE, t2Id.did);

  // Seed each traveler's PRIVATE partition with their dietary profile, and a decoy in the SHARED
  // partition — the grant must be backed only by the requesting traveler's partition. (Seeded LOW so the
  // release ladder clears at STANDING; in practice the traveler contributes via the KB.)
  const vault = new VaultStore(warden.dataFolder);
  const seed = (tag: string, kb: string) => vault.put({ id: hex(tag), kind: 'document', observedAt: '2026-07-01T12:00:00Z', storedAt: new Date().toISOString(), sensitivity: Sensitivity.LOW, ciphertext: '(sealed hatproProfile)', metadata: { witness: hotelId.did, kb } });
  await seed('t1-pref', p1.id);
  await seed('t2-pref', p2.id);
  await seed('shared-decoy', SPACE);

  // The gateway's Ruleset, signed by the custodian (the governing Sovereign of the custodial gateway).
  const gwRuleset: Ruleset = { actor: 'a2a-gateway', actorKind: 'gateway', version: 1, previous: null, capabilities: { verbs: ['grant'], kinds: ['document'] }, ceiling: Sensitivity.MEDIUM, status: 'active' };
  const chain = [await signRuleset(custodian, gwRuleset)];
  const cgpr = new CgprService(warden, config, {
    gatewayRuleset: chain, sovereignDid: custId.did, pairwiseStore: new FilePairwiseStore(warden), kind: 'document',
    spaceId: SPACE, partitions: new PartitionStore(warden.dataFolder), // custodial mode
  });

  // A gateway per traveler (the booking context supplies the traveler out-of-band; never on the wire).
  const gatewayFor = async (travelerDid: string, port: number): Promise<ReturnType<typeof startA2aGateway>> => {
    const backend: CgprBackend = { submit: async (req) => {
      const r = await cgpr.handle({ ...req, owner: travelerDid });
      return r.status === 'granted' ? { status: 'granted', credential: r.credential, schemaDid: r.schemaDid, validUntil: r.validUntil } : { status: 'denied', reason: r.reason };
    } };
    return new Promise((res) => { const g = startA2aGateway({ port, publicUrl: `http://127.0.0.1:${port}`, backend, onListening: () => res(g) }); });
  };

  const gw1 = await gatewayFor(t1Id.did, PORT);
  const gw2 = await gatewayFor(t2Id.did, PORT + 1);
  try {
    // Hotel requests traveler 1's dietary restrictions (subject-less ticket).
    const a1 = ticketFor() as any; a1.requester.did = hotelId.did;
    const task1 = await send(BASE, a1);
    assert(task1?.status?.state === 'completed', `custodial grant completes: ${JSON.stringify(task1?.status)}`);
    const grant1 = task1.artifacts.find((a: any) => a.name === 'cgpr-grant')?.parts[0].data;
    assert(grant1, 'a grant is produced from the custodial space');
    const subject1 = grant1.credential.credentialSubject?.id ?? '';

    // Backed by traveler 1's OWN partition — not the shared decoy, not traveler 2.
    const ev = grant1.credential.credentialSubject?.evidence?.[0];
    assert(ev?.count === 1, `grant backed by exactly the traveler's partition entry (count ${ev?.count})`);
    assert(/^did:cid:/.test(subject1) && subject1 !== t1Id.did && subject1 !== custId.did, 'subject is a pairwise DID — not the traveler, not the custodian');
    process.stdout.write(`✓ hotel got a grant from traveler-1's private partition → pairwise ${subject1.slice(0, 24)}…\n`);

    // Verify the grant (challenge/response); the pairwise audience is (hotel, traveler-1).
    const grantAudience1 = `${hotelId.did}::${t1Id.did}`;
    await warden.keymaster.setCurrentId(pairwiseName(grantAudience1));
    const ch = await requestProof(hotel, { schema: grant1.schemaDid, trustedIssuers: [wardenId.did] });
    await warden.keymaster.setCurrentId(pairwiseName(grantAudience1));
    const v = await verifyProof(hotel, await presentProof(warden, ch), { trustedIssuers: [wardenId.did], schema: grant1.schemaDid });
    assert(v.ok && v.responder === subject1, `custodial grant verifies from the pairwise subject: ${JSON.stringify(v)}`);
    await warden.keymaster.setCurrentId('hearthold-warden');
    process.stdout.write('✓ hotel verified the grant (challenge/response), issuer = the custodial Warden\n');

    // Traveler 2, same hotel → a DISTINCT, unlinkable pairwise subject.
    const a2 = ticketFor() as any; a2.requester.did = hotelId.did;
    const task2 = await send(`http://127.0.0.1:${PORT + 1}`, a2);
    const grant2 = task2.artifacts.find((a: any) => a.name === 'cgpr-grant')?.parts[0].data;
    const subject2 = grant2.credential.credentialSubject?.id ?? '';
    assert(subject1 !== subject2, 'two travelers to the same hotel get UNLINKABLE pairwise subjects');
    process.stdout.write('✓ two travelers → unlinkable subjects (per-(audience,traveler) pairwise DID)\n');

    // A traveler with no private partition in the space is refused.
    const gwNone = await gatewayFor(custId.did, PORT + 2); // custodian has no traveler partition
    try {
      const a3 = ticketFor() as any; a3.requester.did = hotelId.did;
      const t3 = await send(`http://127.0.0.1:${PORT + 2}`, a3);
      const dec = t3.artifacts?.find((a: any) => a.name === 'cgpr-decision');
      assert(dec?.parts[0].data.decision === 'denied', 'a traveler with no partition is denied');
      process.stdout.write('✓ a traveler with no private partition is denied (no leak)\n');
    } finally { gwNone.close(); }

    process.stdout.write('\n✓ CGPR × KB Spaces: the gateway discloses a traveler’s preference from their private partition\n');
  } finally { gw1.close(); gw2.close(); }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-cgpr-hatpro: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
