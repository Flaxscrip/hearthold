/**
 * e2e: the direct Warden↔Sovereign approval channel (milestone A2-wire).
 *
 * The Emissary sends ONE evidence-request. Internally, the Warden — not the Emissary — obtains the
 * Sovereign's proof-of-human approval over its own channel (here the real `makeSovereignHandler` +
 * a PIN gate stands in for the Signet), mints the graph with the approval block, and returns it.
 * The Emissary is never in the authorization path (§7.7). Also checks the decline path.
 *
 * Isolated data root; run:  npm run e2e:evidence-direct
 */
import { createHash } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  acceptCredential,
  requestProof,
  presentProof,
  verifyProof,
  Sensitivity,
  PROTOCOL_VERSION,
  type EvidenceRequest,
  type ApprovalResponseMessage,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService, type SovereignApprover } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate, DenyGate, type ApprovalGate } from '@hearthold/sovereign/signet';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-direct';

  const warden = await openKeymaster('warden', config, pass);
  const witness = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);

  const delSchema = await ensureDelegationSchema(warden);
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const delCred = await issueDelegation(warden, witnessId.did, delSchema, { kinds: ['location'], validUntil: oneYear });
  await new DelegationStore(warden).record(witnessId.did, delCred);

  const store = new VaultStore(warden.dataFolder);
  for (const [i, day] of ['2026-02-04', '2026-03-11', '2026-04-20'].entries()) {
    await store.put({
      id: hex(`loc-${i}`),
      kind: 'location',
      observedAt: `${day}T09:00:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.MEDIUM,
      ciphertext: '(sealed)',
      metadata: { witness: witnessId.did },
    });
  }

  // The Warden's direct channel to the Sovereign — the real Sovereign handler + Signet gate,
  // driven in-process. Over DIDComm this is `transport.request(sovereignDid, approval-request)`.
  const makeApprover = (gate: ApprovalGate): SovereignApprover => {
    const handler = makeSovereignHandler(sovereign, gate);
    return {
      async requestApproval(req) {
        const reply = await handler(req, wardenId.did);
        return reply as ApprovalResponseMessage;
      },
    };
  };

  const baseReq: EvidenceRequest = {
    type: 'hearthold/evidence-request',
    version: PROTOCOL_VERSION,
    claim: 'Resided in FR during 2026-H1',
    disclosureMode: 'ATTESTATION',
    spec: { kind: 'location', from: '2026-01-01', to: '2026-06-30', structured: { type: 'residence', country: 'FR' } },
  };
  const delegationValid = await new DelegationStore(warden).isAuthorized(witnessId.did);

  process.stdout.write('\n▸ Decline path: the Sovereign says no → the Warden mints nothing\n');
  const denied = await new EvidenceService(warden, { ...config, sovereignDid: sovId.did }, makeApprover(new DenyGate())).handle(
    baseReq,
    witnessId.did,
    delegationValid,
  );
  assert(denied.status === 'denied', 'declined by the Sovereign → denied');

  process.stdout.write('\n▸ Approve path: the Warden gets the approval directly, Emissary uninvolved\n');
  const evidence = new EvidenceService(warden, { ...config, sovereignDid: sovId.did }, makeApprover(new PinGate('4242', '4242')));
  const granted = await evidence.handle(baseReq, witnessId.did, delegationValid);
  assert(granted.status === 'granted', 'MEDIUM claim granted via the direct channel (one request)');
  if (granted.status !== 'granted') throw new Error('not granted');

  await acceptCredential(sovereign, granted.credentialDid);
  const challenge = await requestProof(verifier, { schema: granted.schemaDid, trustedIssuers: [wardenId.did] });
  const presentation = await presentProof(sovereign, challenge);
  const result = await verifyProof(verifier, presentation, { trustedIssuers: [wardenId.did], schema: granted.schemaDid });
  assert(result.ok, 'verifier verifies the evidence graph');

  const claims = result.disclosed[0]?.claims ?? {};
  const appr = claims.approval as { approver?: string; humanProof?: { level?: number } } | undefined;
  assert(appr?.approver === sovId.did, 'approval approver = the Sovereign');
  assert(appr?.humanProof?.level === 1, 'approval carries proof-of-human level 1');

  process.stdout.write('\n✓ A2-wire: direct Warden↔Sovereign approval — Emissary never in the authorization path\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-evidence-direct: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
