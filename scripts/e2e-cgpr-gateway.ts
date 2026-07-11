/**
 * e2e: CGPR gateway happy-path (A2A brief §4.3). A real HTTP round-trip:
 *
 *   Agent Card (well-known) advertises the CGPR extension + A2A 1.0.0 → C sends message/send with a
 *   DataPart CgprRequestArtifact (ticket + its own DID, NO subject) → gateway validates the ticket,
 *   translates, relays to the Warden's CGPR service → the Warden authors consent, the gateway actor is
 *   authorized by its Sovereign-signed Ruleset, the release ladder clears at STANDING (LOW) → mints a
 *   scoped, single-use attestation to a FRESH pairwise DID → task completes with a CgprGrant.
 *
 * Then C verifies the grant by challenge/response and confirms the subject is a pairwise DID, not the
 * Sovereign. A reused ticket is refused (single-use). Isolated data root; run: npm run e2e:cgpr-gateway
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
  Sensitivity,
  type Ruleset,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { FilePairwiseStore } from '@hearthold/warden/pairwise-store';
import { CgprService } from '@hearthold/warden/cgpr';
import { startA2aGateway, AGENT_CARD_PATH, A2A_RPC_PATH, A2A_VERSION, type CgprBackend } from '@hearthold/a2a-gateway';
import { CGPR_EXTENSION_URI } from '@hearthold/cgpr-types';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
};
const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;

async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${A2A_RPC_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Extensions': CGPR_EXTENSION_URI },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-cgpr-gw';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const c = await openKeymaster('verifier', config, pass); // the counterparty C (its own DID)
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const cId = await ensureIdentity(c, config);

  // Seed one LOW 'document' artefact standing in for a HATPro dietary-preference profile.
  await new VaultStore(warden.dataFolder).put({
    id: hex('pref-1'),
    kind: 'document',
    observedAt: '2026-07-01T12:00:00Z',
    storedAt: new Date().toISOString(),
    sensitivity: Sensitivity.LOW,
    ciphertext: '(sealed)',
    metadata: { witness: cId.did },
  });

  // The gateway actor's Sovereign-signed Ruleset (constraint #3): may 'grant' on 'document', ceiling MEDIUM.
  const gwRuleset: Ruleset = {
    actor: 'a2a-gateway',
    actorKind: 'gateway',
    version: 1,
    previous: null,
    capabilities: { verbs: ['grant'], kinds: ['document'] },
    ceiling: Sensitivity.MEDIUM,
    status: 'active',
  };
  const chain = [await signRuleset(sovereign, gwRuleset)];

  const pairwiseStore = new FilePairwiseStore(warden);
  const cgpr = new CgprService(warden, config, {
    gatewayRuleset: chain,
    sovereignDid: sovId.did,
    pairwiseStore,
    kind: 'document',
  });

  // The gateway backend: the Warden's CGPR service (in-process here; DIDComm relay in production).
  const backend: CgprBackend = {
    submit: async (req) => {
      const r = await cgpr.handle(req);
      return r.status === 'granted'
        ? { status: 'granted', credential: r.credential, schemaDid: r.schemaDid, validUntil: r.validUntil }
        : { status: 'denied', reason: r.reason };
    },
  };

  const gateway = await new Promise<ReturnType<typeof startA2aGateway>>((resolve) => {
    const gw = startA2aGateway({ port: PORT, publicUrl: BASE, backend, onListening: () => resolve(gw) });
  });

  try {
    // 1. Agent Card advertises CGPR + A2A 1.0.0.
    const card = (await (await fetch(`${BASE}${AGENT_CARD_PATH}`)).json()) as Record<string, any>;
    assert(card.protocolVersion === A2A_VERSION, `agent card must pin A2A ${A2A_VERSION}`);
    const ext = card.capabilities?.extensions?.[0];
    assert(ext?.uri === CGPR_EXTENSION_URI && ext?.required === true, 'agent card must advertise CGPR as required');
    assert(!JSON.stringify(card).includes(sovId.did), 'agent card must not leak the Sovereign DID');
    process.stdout.write(`✓ Agent Card advertises CGPR (${CGPR_EXTENSION_URI}) on A2A ${A2A_VERSION}\n`);

    // 2. C sends a CGPR request (ticket + its own DID; NO subject).
    const ticketId = randomUUID();
    const artifact = {
      ticket: {
        ticketId,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        singleUse: true,
        scopes: ['foodAndBeverage.dietaryRestrictions'],
        purpose: 'Seat the guest with a suitable menu',
      },
      requester: { did: cId.did, agentCardUrl: 'https://c.example/agent-card.json' },
      validForMinutes: 15,
    };
    assert(!JSON.stringify(artifact).includes(sovId.did), 'the pre-approval request must carry no subject DID');

    const sendRes = await rpc('message/send', {
      message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: artifact }] },
    });
    const task = sendRes.result as { id: string; status: { state: string }; artifacts: any[] };
    assert(task?.status?.state === 'completed', `task must complete, got ${JSON.stringify(sendRes)}`);
    const grantArtifact = task.artifacts.find((a) => a.name === 'cgpr-grant');
    assert(grantArtifact, 'task must carry a cgpr-grant artifact');
    const grant = grantArtifact.parts[0].data as {
      ticketId: string;
      credential: { credentialSubject?: { id?: string }; issuer?: string };
      schemaDid: string;
      validUntil: string;
      singleUse: boolean;
    };
    assert(grant.ticketId === ticketId && grant.singleUse === true, 'grant must echo the ticketId + be single-use');

    // 3. The grant's subject is a FRESH pairwise DID — never the Sovereign.
    const subject = grant.credential.credentialSubject?.id ?? '';
    assert(/^did:cid:/.test(subject), 'grant subject must be a did:cid');
    assert(subject !== sovId.did, 'grant subject must NOT be the Sovereign DID');
    const link = await pairwiseStore.get(subject);
    assert(link?.subjectDid === sovId.did && link.audience === cId.did, 'subject must be the pairwise DID for C, linked Warden-side');
    process.stdout.write(`✓ grant minted to pairwise subject ${subject.slice(0, 28)}… (Sovereign hidden)\n`);

    // 4. tasks/get returns the same task.
    const got = (await rpc('tasks/get', { id: task.id })).result as { id: string };
    assert(got?.id === task.id, 'tasks/get must return the task');

    // 5. C verifies the grant by challenge/response — the pairwise subject presents; scopes disclosed.
    await warden.keymaster.setCurrentId(pairwiseName(cId.did));
    const challenge = await requestProof(c, { schema: grant.schemaDid, trustedIssuers: [wardenId.did] });
    await warden.keymaster.setCurrentId(pairwiseName(cId.did));
    const presentation = await presentProof(warden, challenge);
    const verified = await verifyProof(c, presentation, { trustedIssuers: [wardenId.did], schema: grant.schemaDid });
    assert(verified.ok && verified.responder === subject, `grant must verify from the pairwise subject: ${JSON.stringify(verified)}`);
    const scopes = (verified.disclosed[0]?.claims?.structured as { scopes?: string[] } | undefined)?.scopes ?? [];
    assert(scopes.includes('foodAndBeverage.dietaryRestrictions'), 'disclosed claim must carry the requested scope');
    process.stdout.write('✓ C verified the grant (challenge/response), scope disclosed, issuer = Warden\n');
    await warden.keymaster.setCurrentId('hearthold-warden');

    // 6. Reusing the same ticket is refused (single-use).
    const reuse = await rpc('message/send', {
      message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: artifact }] },
    });
    const reuseState = (reuse.result as { status?: { state?: string } })?.status?.state;
    assert(reuseState === 'rejected' || reuseState === 'failed', `reused ticket must be refused, got ${reuseState}`);
    process.stdout.write(`✓ single-use ticket: reuse refused (${reuseState})\n`);

    process.stdout.write('\n✓ CGPR gateway happy-path: A2A edge → Warden CGPR service → pairwise grant\n');
  } finally {
    gateway.close();
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-cgpr-gateway: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
