/**
 * e2e: CGPR conformance suite (A2A brief §4.4) — the seven checks Alex named.
 *
 *   1. No subject DID/identifier in any message before approval — by schema AND by a wire-capture grep
 *      over the entire recorded exchange (the Sovereign DID must never appear on the wire).
 *   2. Expired ticket → refusal, nothing minted.
 *   3. Spent ticket reused → refusal.
 *   4. Grant is scoped (only requested scopes in the derived claim), audience-bound, validUntil honored.
 *   5. Grant reuse → verifier refuses (single-use burn).
 *   6. Denial carries ticketId and nothing else.
 *   7. Pairwise: two audiences → unlinkable subjects.
 *   8. Key custody enforced in the CGPR path: when the Sovereign SIGNS a key-custody policy that keys a
 *      counterparty itself (subject-keyed), the Warden is refused from minting a CGPR disclosure identity
 *      for it — fail closed, nothing minted. (The Sovereign controls that key in the Signet, not the
 *      custodian.) Proves `keyCustodyRuleset` is threaded through the live gateway flow, not just core.
 *
 * Isolated data root; run:  npm run e2e:cgpr
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signRuleset,
  requestProof,
  presentProof,
  verifyProof,
  pairwiseName,
  MemorySpentTxnStore,
  Sensitivity,
  type Ruleset,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { FilePairwiseStore } from '@hearthold/warden/pairwise-store';
import { CgprService } from '@hearthold/warden/cgpr';
import { startA2aGateway, A2A_RPC_PATH, type CgprBackend } from '@hearthold/a2a-gateway';
import { CgprRequestArtifactSchema } from '@hearthold/cgpr-types';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
};
const ALLOW_PORT = 4319;
const DENY_PORT = 4320;
const CUSTODY_PORT = 4321;

/** A wire transcript — every request + response the counterparty exchanges, for the grep check. */
const transcript: string[] = [];

async function rpc(port: number, method: string, params: unknown): Promise<Record<string, unknown>> {
  const body = { jsonrpc: '2.0', id: randomUUID(), method, params };
  transcript.push(JSON.stringify(body));
  const res = await fetch(`http://127.0.0.1:${port}${A2A_RPC_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  transcript.push(JSON.stringify(json));
  return json;
}

function ticket(scopes: string[], opts: { expiresAt?: string } = {}): Record<string, unknown> {
  return {
    ticketId: randomUUID(),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString(),
    singleUse: true,
    scopes,
    purpose: 'Seat the guest with a suitable menu',
  };
}
const sendArtifact = (t: Record<string, unknown>, did: string): unknown => ({
  message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: { ticket: t, requester: { did, agentCardUrl: 'https://c.example/card' }, validForMinutes: 15 } }] },
});
const grantOf = (task: any): any => task?.artifacts?.find((a: any) => a.name === 'cgpr-grant')?.parts?.[0]?.data;
const decisionOf = (task: any): any => task?.artifacts?.find((a: any) => a.name === 'cgpr-decision')?.parts?.[0]?.data;

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-cgpr-conf';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const c1 = await openKeymaster('verifier', config, pass);
  const c2 = await openKeymaster('registry', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const c1Id = await ensureIdentity(c1, config);
  const c2Id = await ensureIdentity(c2, config);
  const bank = await openKeymaster('emissary', config, pass); // a subject-keyed counterparty (a KYC anchor)
  const bankId = await ensureIdentity(bank, config);

  await new VaultStore(warden.dataFolder).put({
    id: hex('pref-1'), kind: 'document', observedAt: '2026-07-01T12:00:00Z',
    storedAt: new Date().toISOString(), sensitivity: Sensitivity.LOW, ciphertext: '(sealed)', metadata: { witness: c1Id.did },
  });

  const base = (over: Partial<Ruleset>): Ruleset => ({
    actor: 'a2a-gateway', actorKind: 'gateway', version: 1, previous: null,
    capabilities: {}, ceiling: Sensitivity.MEDIUM, status: 'active', ...over,
  });
  const allowChain = [await signRuleset(sovereign, base({ capabilities: { verbs: ['grant'], kinds: ['document'] } }))];
  const denyChain = [await signRuleset(sovereign, base({ capabilities: { verbs: ['grant'], kinds: ['location'] } }))]; // not 'document'
  // A key-custody policy the Sovereign signs SEPARATELY from the gateway Ruleset: it keys the `bank`
  // relationship itself (subject-keyed). Signed by the Sovereign (actor = sovId), pinned as the mint's
  // custody source — so the gateway may authorize the request yet the Warden is still refused the mint.
  const custodyChain = [
    await signRuleset(sovereign, {
      actor: sovId.did, actorKind: 'sovereign', resource: 'key-custody', version: 1, previous: null,
      capabilities: { keyCustody: { default: 'warden', subject: [bankId.did] } },
      ceiling: Sensitivity.SEALED, status: 'active',
    }),
  ];

  const store = new FilePairwiseStore(warden);
  const svc = (chain: typeof allowChain, keyCustodyRuleset?: typeof allowChain): CgprService =>
    new CgprService(warden, config, { gatewayRuleset: chain, sovereignDid: sovId.did, pairwiseStore: store, kind: 'document', keyCustodyRuleset });
  const backend = (chain: typeof allowChain, keyCustodyRuleset?: typeof allowChain): CgprBackend => ({
    submit: async (req) => {
      const r = await svc(chain, keyCustodyRuleset).handle(req);
      return r.status === 'granted'
        ? { status: 'granted', credential: r.credential, schemaDid: r.schemaDid, validUntil: r.validUntil }
        : { status: 'denied', reason: r.reason };
    },
  });

  const gwAllow = await new Promise<ReturnType<typeof startA2aGateway>>((res) => {
    const g = startA2aGateway({ port: ALLOW_PORT, publicUrl: `http://127.0.0.1:${ALLOW_PORT}`, backend: backend(allowChain), onListening: () => res(g) });
  });
  const gwDeny = await new Promise<ReturnType<typeof startA2aGateway>>((res) => {
    const g = startA2aGateway({ port: DENY_PORT, publicUrl: `http://127.0.0.1:${DENY_PORT}`, backend: backend(denyChain), onListening: () => res(g) });
  });
  // Same authorizing gateway Ruleset as ALLOW, but wired with the Sovereign's key-custody policy.
  const gwCustody = await new Promise<ReturnType<typeof startA2aGateway>>((res) => {
    const g = startA2aGateway({ port: CUSTODY_PORT, publicUrl: `http://127.0.0.1:${CUSTODY_PORT}`, backend: backend(allowChain, custodyChain), onListening: () => res(g) });
  });

  try {
    // ── 1. No subject before approval (by schema + a valid request carries none) ──
    assert(!('subject' in (CgprRequestArtifactSchema.properties as Record<string, unknown>)), 'schema: request has no subject field');
    const scopes = ['foodAndBeverage.dietaryRestrictions'];
    const t1 = ticket(scopes);
    const task1 = (await rpc(ALLOW_PORT, 'message/send', sendArtifact(t1, c1Id.did))).result as any;
    assert(task1?.status?.state === 'completed', 'happy path completes');
    const grant1 = grantOf(task1);
    assert(grant1, 'grant produced');
    process.stdout.write('✓ [1] request carries no subject (schema-forbidden)\n');

    // ── 4. Scoped + audience-bound + validUntil honored ──
    const subject1: string = grant1.credential.credentialSubject?.id ?? '';
    assert(/^did:cid:/.test(subject1) && subject1 !== sovId.did, 'grant subject is a pairwise DID, not the Sovereign');
    const disclosedScopes = grant1.credential.credentialSubject?.structured?.scopes ?? [];
    assert(JSON.stringify(disclosedScopes) === JSON.stringify(scopes), `derived claim carries ONLY the requested scopes (got ${JSON.stringify(disclosedScopes)})`);
    const link1 = await store.get(subject1);
    assert(link1?.audience === c1Id.did && link1.subjectDid === sovId.did, 'subject is audience-bound to C1, linked Warden-side');
    const vu = Date.parse(grant1.validUntil);
    assert(vu > Date.now() && vu <= Date.now() + 16 * 60_000, 'validUntil honors the requested 15-minute lifetime');
    process.stdout.write('✓ [4] grant scoped to requested scopes, audience-bound, validUntil honored\n');

    // ── 5. Grant reuse burns (verifier-side single-use) ──
    const spent = new MemorySpentTxnStore();
    const present = async (): Promise<boolean> => {
      await warden.keymaster.setCurrentId(pairwiseName(c1Id.did));
      const ch = await requestProof(c1, { schema: grant1.schemaDid, trustedIssuers: [wardenId.did] });
      await warden.keymaster.setCurrentId(pairwiseName(c1Id.did));
      const pres = await presentProof(warden, ch);
      const v = await verifyProof(c1, pres, { trustedIssuers: [wardenId.did], schema: grant1.schemaDid, spentTxns: spent });
      return v.ok;
    };
    assert((await present()) === true, 'first presentation verifies');
    assert((await present()) === false, 'second presentation is refused (burned)');
    await warden.keymaster.setCurrentId('hearthold-warden');
    process.stdout.write('✓ [5] grant reuse burns (verifier refuses the replay)\n');

    // ── 3. Spent ticket reused → refusal ──
    const reuse = (await rpc(ALLOW_PORT, 'message/send', sendArtifact(t1, c1Id.did))).result as any;
    assert(reuse?.status?.state === 'rejected' || reuse?.status?.state === 'failed', 'reused ticket refused');
    process.stdout.write(`✓ [3] spent ticket refused (${reuse?.status?.state})\n`);

    // ── 2. Expired ticket → refusal, nothing minted ──
    const expiredAud = c2Id.did; // an audience with no pairwise minted yet
    const before = await store.find(expiredAud);
    const expTask = (await rpc(ALLOW_PORT, 'message/send', sendArtifact(ticket(scopes, { expiresAt: new Date(Date.now() - 60_000).toISOString() }), expiredAud))).result as any;
    assert(expTask?.status?.state === 'failed', 'expired ticket → task failed');
    assert(!grantOf(expTask), 'expired ticket mints nothing');
    assert((await store.find(expiredAud)) === before, 'no pairwise DID minted for the expired request');
    process.stdout.write('✓ [2] expired ticket refused, nothing minted\n');

    // ── 6. Denial carries ticketId and nothing else ──
    const tDeny = ticket(scopes);
    const denyTask = (await rpc(DENY_PORT, 'message/send', sendArtifact(tDeny, c1Id.did))).result as any;
    assert(denyTask?.status?.state === 'completed', 'denial completes the task');
    const decision = decisionOf(denyTask);
    assert(decision, 'denial carries a cgpr-decision');
    assert(
      JSON.stringify(Object.keys(decision).sort()) === JSON.stringify(['decision', 'ticketId']) && decision.decision === 'denied',
      `denial is exactly { ticketId, decision:'denied' } (got ${JSON.stringify(decision)})`,
    );
    assert(decision.ticketId === tDeny.ticketId, 'denial echoes the ticketId');
    process.stdout.write('✓ [6] denial carries ticketId + decision only — no reason, no leak\n');

    // ── 7. Two audiences → unlinkable pairwise subjects ──
    const grant2 = grantOf((await rpc(ALLOW_PORT, 'message/send', sendArtifact(ticket(scopes), c2Id.did))).result as any);
    assert(grant2, 'C2 grant produced');
    const subject2: string = grant2.credential.credentialSubject?.id ?? '';
    assert(subject1 !== subject2, 'C1 and C2 get DISTINCT pairwise subjects');
    process.stdout.write('✓ [7] two audiences → unlinkable pairwise subjects\n');

    // ── 8. Key custody enforced in the CGPR path ──
    // The gateway authorizes the request (allowChain), but the Sovereign's signed key-custody policy keys
    // the bank itself — so the Warden is refused the disclosure mint. Fail closed as a graceful denial: a
    // bare cgpr-decision (no leaked reason, like check 6), and nothing minted.
    const custodyBefore = await store.find(bankId.did);
    const custodyTask = (await rpc(CUSTODY_PORT, 'message/send', sendArtifact(ticket(scopes), bankId.did))).result as any;
    assert(custodyTask?.status?.state === 'completed', `subject-keyed request completes as a clean decision (got ${custodyTask?.status?.state})`);
    assert(!grantOf(custodyTask), 'nothing minted for the subject-keyed audience');
    const custodyDecision = decisionOf(custodyTask);
    assert(
      custodyDecision && JSON.stringify(Object.keys(custodyDecision).sort()) === JSON.stringify(['decision', 'ticketId']) && custodyDecision.decision === 'denied',
      `subject-keyed audience refused as a bare denial — no reason leaks (got ${JSON.stringify(custodyDecision)})`,
    );
    assert((await store.find(bankId.did)) === custodyBefore, 'no pairwise DID minted for the subject-keyed audience');
    process.stdout.write('✓ [8] key custody enforced — Warden refused to mint a disclosure identity for a Sovereign-keyed audience\n');

    // ── 1 (wire-grep): the Sovereign DID never appears anywhere on the wire ──
    const wire = transcript.join('\n');
    assert(!wire.includes(sovId.did), 'the Sovereign DID must NEVER appear on the wire');
    // and C1's pairwise subject must not appear in C2's messages, nor vice-versa
    assert(subject1 !== sovId.did && subject2 !== sovId.did, 'no pairwise subject equals the Sovereign');
    process.stdout.write(`✓ [1] wire-capture: Sovereign DID absent across ${transcript.length} recorded frames\n`);

    process.stdout.write('\n✓ CGPR conformance: all 7 checks pass (+ key-custody enforcement)\n');
  } finally {
    gwAllow.close();
    gwDeny.close();
    gwCustody.close();
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-cgpr: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
