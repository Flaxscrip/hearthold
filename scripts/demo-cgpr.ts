/**
 * demo:cgpr — the Consent-Gated Preference Request flow, end to end, narrated (A2A brief §4.5).
 *
 * Runs in under a minute against the live Archon node. Spins the A2A gateway over a seeded vault
 * (a HATPro-shaped dietary-preference profile), prints the Agent Card URL, then walks C's side —
 * send request → poll task → receive grant → verify the VC → attempt reuse → watch it burn — printing
 * the equivalent `curl` for every step so Alex can replay any of it by hand.
 *
 *   npm run demo:cgpr                     # self-contained narrated walk, then exits
 *   HEARTHOLD_DEMO_SERVE=1 npm run demo:cgpr   # ...then keeps the gateway up so you can curl it live
 *
 * Uses its own throwaway data root (os tmp) unless HEARTHOLD_DATA_ROOT is set — never your vault.
 */
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig, openKeymaster, ensureIdentity, signRuleset,
  requestProof, presentProof, verifyProof, pairwiseName, MemorySpentTxnStore, Sensitivity,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { FilePairwiseStore } from '@hearthold/warden/pairwise-store';
import { CgprService } from '@hearthold/warden/cgpr';
import { startA2aGateway, AGENT_CARD_PATH, A2A_RPC_PATH, A2A_VERSION } from '@hearthold/a2a-gateway';
import { CGPR_EXTENSION_URI } from '@hearthold/cgpr-types';

// Use a throwaway data root unless one is set — never the operator's real vault.
if (!process.env.HEARTHOLD_DATA_ROOT) process.env.HEARTHOLD_DATA_ROOT = join(tmpdir(), 'hearthold-cgpr-demo');

const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;
const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const p = (s = ''): void => process.stdout.write(s + '\n');
const step = (n: number, title: string): void => p(`\n\x1b[1m━━━ ${n}. ${title}\x1b[0m`);
const show = (label: string, cmd: string): void => p(`  \x1b[2m$ ${cmd}\x1b[0m   \x1b[36m# ${label}\x1b[0m`);

async function rpc(method: string, params: unknown): Promise<any> {
  const body = { jsonrpc: '2.0', id: randomUUID(), method, params };
  const res = await fetch(`${BASE}${A2A_RPC_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-cgpr-demo';
  p(`\n\x1b[1mHearthold · Consent-Gated Preference Requests (CGPR) — live demo\x1b[0m`);
  p(`  A2A ${A2A_VERSION} · extension ${CGPR_EXTENSION_URI}`);
  p(`  node ${config.nodeUrl} · data root ${process.env.HEARTHOLD_DATA_ROOT}`);

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const hotel = await openKeymaster('verifier', config, pass); // "C" — the hotel's AI agent
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const hotelId = await ensureIdentity(hotel, config);

  // Seed the Sovereign's vault with a HATPro-shaped dietary-preference profile (LOW → clears STANDING).
  await new VaultStore(warden.dataFolder).put({
    id: hex('hatpro-profile'), kind: 'document', observedAt: '2026-07-01T12:00:00Z',
    storedAt: new Date().toISOString(), sensitivity: Sensitivity.LOW, ciphertext: '(sealed hatproProfile)',
    metadata: { witness: hotelId.did, profile: 'hatpro' },
  });

  // The gateway actor's Sovereign-signed Ruleset: may 'grant' on 'document', ceiling MEDIUM.
  const chain = [await signRuleset(sovereign, {
    actor: 'a2a-gateway', actorKind: 'gateway', version: 1, previous: null,
    capabilities: { verbs: ['grant'], kinds: ['document'] }, ceiling: Sensitivity.MEDIUM, status: 'active',
  })];
  const store = new FilePairwiseStore(warden);
  const svc = new CgprService(warden, config, { gatewayRuleset: chain, sovereignDid: sovId.did, pairwiseStore: store, kind: 'document' });
  const gateway = await new Promise<ReturnType<typeof startA2aGateway>>((res) => {
    const g = startA2aGateway({
      port: PORT, publicUrl: BASE, onListening: () => res(g),
      backend: { submit: async (req) => {
        const r = await svc.handle(req);
        return r.status === 'granted' ? { status: 'granted', credential: r.credential, schemaDid: r.schemaDid, validUntil: r.validUntil } : { status: 'denied', reason: r.reason };
      } },
    });
  });

  // ── 1. Discover the A-side agent ──
  step(1, 'The hotel AI discovers the Sovereign gateway (Agent Card)');
  show('fetch the Agent Card at the well-known URI', `curl ${BASE}${AGENT_CARD_PATH}`);
  const card = await (await fetch(`${BASE}${AGENT_CARD_PATH}`)).json() as any;
  p(`  → protocolVersion ${card.protocolVersion}, extension "${card.capabilities.extensions[0].uri}" (required: ${card.capabilities.extensions[0].required})`);

  // ── 2. Send the request (subject-less ticket) ──
  step(2, 'The hotel sends a CGPR request — a single-use ticket + its own DID, NO subject');
  const ticketId = randomUUID();
  const artifact = {
    ticket: { ticketId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), singleUse: true, scopes: ['foodAndBeverage.dietaryRestrictions'], purpose: 'Plan the guest menu' },
    requester: { did: hotelId.did, agentCardUrl: 'https://hotel.example/agent-card.json' }, validForMinutes: 4320,
  };
  const sendBody = { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: artifact }] } } };
  show('message/send with a DataPart carrying the CgprRequestArtifact', `curl -X POST ${BASE}${A2A_RPC_PATH} -H 'Content-Type: application/json' -d '${JSON.stringify(sendBody).slice(0, 60)}…'`);
  p(`  \x1b[2mticket scopes: ${JSON.stringify(artifact.ticket.scopes)} · purpose: "${artifact.ticket.purpose}" · (no subject field exists)\x1b[0m`);
  const task = (await rpc('message/send', sendBody.params)).result;
  p(`  → task ${task.id.slice(0, 8)}… state=\x1b[1m${task.status.state}\x1b[0m`);
  p(`  \x1b[2m(the Warden authored the consent line, authorized the gateway against its signed Ruleset, and — LOW clears STANDING — minted without a step-up)\x1b[0m`);

  // ── 3. Poll the task ──
  step(3, 'Poll the task until it completes');
  show('tasks/get', `curl -X POST ${BASE}${A2A_RPC_PATH} -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"${task.id}"}}'`);
  const got = (await rpc('tasks/get', { id: task.id })).result;
  const grant = got.artifacts.find((a: any) => a.name === 'cgpr-grant')?.parts[0].data;
  const subject = grant.credential.credentialSubject?.id ?? '';
  p(`  → state=${got.status.state}, artifact=cgpr-grant`);
  p(`  → grant subject = \x1b[1m${subject.slice(0, 40)}…\x1b[0m  \x1b[36m(a FRESH pairwise DID — the Sovereign's real DID never appears)\x1b[0m`);
  p(`  → validUntil ${grant.validUntil} · singleUse ${grant.singleUse}`);

  // ── 4. Verify the grant offline (challenge/response) ──
  step(4, 'The hotel verifies the grant — challenge/response, issuer = the Warden');
  const spent = new MemorySpentTxnStore();
  const present = async (): Promise<any> => {
    await warden.keymaster.setCurrentId(pairwiseName(hotelId.did));
    const ch = await requestProof(hotel, { schema: grant.schemaDid, trustedIssuers: [wardenId.did] });
    await warden.keymaster.setCurrentId(pairwiseName(hotelId.did));
    const pres = await presentProof(warden, ch);
    return verifyProof(hotel, pres, { trustedIssuers: [wardenId.did], schema: grant.schemaDid, spentTxns: spent });
  };
  const v = await present();
  const scopes = (v.disclosed[0]?.claims?.structured as any)?.scopes ?? [];
  p(`  → verified: \x1b[1m${v.ok}\x1b[0m · responder = the pairwise DID · disclosed scope: ${JSON.stringify(scopes)}`);

  // ── 5. Reuse the grant → it burns ──
  step(5, 'The hotel tries to reuse the same proof — single-use burns');
  const v2 = await present();
  p(`  → second presentation verified: \x1b[1m${v2.ok}\x1b[0m  \x1b[36m(refused: ${v2.reason})\x1b[0m`);
  await warden.keymaster.setCurrentId('hearthold-warden');

  // ── 6. Reuse the ticket → refused ──
  step(6, 'The hotel tries to reuse the ticket — single-use ticket refused');
  const reuse = (await rpc('message/send', sendBody.params)).result;
  p(`  → task state=\x1b[1m${reuse.status.state}\x1b[0m  \x1b[36m(the ticket was already spent)\x1b[0m`);

  p(`\n\x1b[1m✓ CGPR demo complete.\x1b[0m The broker in the middle carried sealed envelopes and learned nothing;`);
  p(`  the hotel got exactly the scoped, expiring, single-use fact it asked for, bound to a throwaway DID.`);

  if (process.env.HEARTHOLD_DEMO_SERVE) {
    p(`\n\x1b[1mGateway staying up at ${BASE}\x1b[0m — try it yourself:`);
    p(`  curl ${BASE}${AGENT_CARD_PATH}`);
    p(`  (Ctrl-C to stop)`);
  } else {
    gateway.close();
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`demo-cgpr: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
