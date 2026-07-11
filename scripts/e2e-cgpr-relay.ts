/**
 * e2e: CGPR gateway over REAL DIDComm — the production backend path.
 *
 * Unlike e2e:cgpr-gateway (in-process backend), here the A2A gateway relays to the Warden over DIDComm
 * v2: the Warden serves `makeCgprHandler` on its mailbox, the gateway's `didCommCgprBackend` sends the
 * translated `hearthold/cgpr-request` and awaits the `hearthold/cgpr-response`. Same edge, same
 * conformance — only the seam between gateway and Warden changes (in-process → DIDComm).
 *
 * Needs the node's DIDComm relay up (like e2e:prove-didcomm). Isolated data root; run: npm run e2e:cgpr-relay
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
  DidCommTransport,
  IDENTITY_NAME,
  Sensitivity,
  type Ruleset,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { FilePairwiseStore } from '@hearthold/warden/pairwise-store';
import { CgprService, makeCgprHandler } from '@hearthold/warden/cgpr';
import { startA2aGateway, didCommCgprBackend, AGENT_CARD_PATH, A2A_RPC_PATH } from '@hearthold/a2a-gateway';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
};
const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;

async function rpc(method: string, params: unknown): Promise<any> {
  const res = await fetch(`${BASE}${A2A_RPC_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  return res.json();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-cgpr-relay';

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass); // the gateway's relay identity
  const sovereign = await openKeymaster('sovereign', config, pass);
  const hotel = await openKeymaster('verifier', config, pass); // C
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(emissary, config);
  const hotelId = await ensureIdentity(hotel, config);

  await new VaultStore(warden.dataFolder).put({
    id: hex('hatpro-profile'), kind: 'document', observedAt: '2026-07-01T12:00:00Z',
    storedAt: new Date().toISOString(), sensitivity: Sensitivity.LOW, ciphertext: '(sealed)', metadata: { witness: hotelId.did },
  });

  const gwRuleset: Ruleset = {
    actor: 'a2a-gateway', actorKind: 'gateway', version: 1, previous: null,
    capabilities: { verbs: ['grant'], kinds: ['document'] }, ceiling: Sensitivity.MEDIUM, status: 'active',
  };
  const chain = [await signRuleset(sovereign, gwRuleset)];
  const cgpr = new CgprService(warden, config, { gatewayRuleset: chain, sovereignDid: sovId.did, pairwiseStore: new FilePairwiseStore(warden), kind: 'document' });

  // Warden serves the CGPR handler on its DIDComm mailbox.
  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, config.nodeUrl);
  await wardenTransport.ready();
  const stopWarden = await wardenTransport.serve(makeCgprHandler(cgpr), { pollMs: 1000 });

  // The gateway relays to the Warden over DIDComm (the production backend).
  const emissaryTransport = new DidCommTransport(emissary, IDENTITY_NAME.emissary, config.nodeUrl);
  await emissaryTransport.ready();
  const backend = didCommCgprBackend(emissaryTransport, wardenId.did);

  const gateway = await new Promise<ReturnType<typeof startA2aGateway>>((res) => {
    const g = startA2aGateway({ port: PORT, publicUrl: BASE, backend, onListening: () => res(g) });
  });

  try {
    process.stdout.write('gateway + Warden wired over DIDComm; sending a CGPR request…\n');
    const card = await (await fetch(`${BASE}${AGENT_CARD_PATH}`)).json() as any;
    assert(card.capabilities.extensions[0].uri.includes('cgpr'), 'agent card advertises CGPR');

    const ticketId = randomUUID();
    const artifact = {
      ticket: { ticketId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), singleUse: true, scopes: ['foodAndBeverage.dietaryRestrictions'], purpose: 'Plan the guest menu' },
      requester: { did: hotelId.did, agentCardUrl: 'https://hotel.example/card' }, validForMinutes: 15,
    };
    const task = (await rpc('message/send', { message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: artifact }] } })).result;
    assert(task?.status?.state === 'completed', `task must complete over DIDComm, got ${JSON.stringify(task?.status)}`);
    const grant = task.artifacts.find((a: any) => a.name === 'cgpr-grant')?.parts[0].data;
    assert(grant, 'grant produced via the DIDComm relay');
    const subject = grant.credential.credentialSubject?.id ?? '';
    assert(/^did:cid:/.test(subject) && subject !== sovId.did, 'grant subject is a pairwise DID, not the Sovereign');
    process.stdout.write(`✓ grant relayed over DIDComm → pairwise subject ${subject.slice(0, 28)}…\n`);

    stopWarden(); // relay done; verify locally

    // Verify the relayed grant end-to-end (challenge/response).
    await warden.keymaster.setCurrentId(pairwiseName(hotelId.did));
    const ch = await requestProof(hotel, { schema: grant.schemaDid, trustedIssuers: [wardenId.did] });
    await warden.keymaster.setCurrentId(pairwiseName(hotelId.did));
    const pres = await presentProof(warden, ch);
    const v = await verifyProof(hotel, pres, { trustedIssuers: [wardenId.did], schema: grant.schemaDid });
    assert(v.ok && v.responder === subject, `relayed grant must verify: ${JSON.stringify(v)}`);
    await warden.keymaster.setCurrentId(IDENTITY_NAME.warden);
    process.stdout.write('✓ relayed grant verifies (challenge/response), issuer = Warden\n');

    process.stdout.write('\n✓ CGPR gateway over real DIDComm: A2A edge → DIDComm relay → Warden CgprService → grant\n');
  } finally {
    gateway.close();
    stopWarden();
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-cgpr-relay: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
