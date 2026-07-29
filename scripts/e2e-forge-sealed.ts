/**
 * e2e: FORGE STEP-UP ESCALATION over SEALED evidence (Aegis §3).
 *
 * Forging a scroll over the member's own MEDIUM+/SEALED evidence used to flat-deny: the disclosure needs a
 * higher proof-of-human level (SEALED → 2) but the Signet gate hardcoded level 1 → "level 1 below required
 * 2". The fix (consistent with the card-face `5712cd1` decision — session factor-1 + Signet proof-of-human
 * factor-2 clears the required tier): the gate now scales the assertion level to the Warden's server-set
 * `requiredLevel`. So a SEALED forge is *approvable* with a Signet PIN instead of refused.
 *
 *   1. gate unit: PinGate scales the assertion level to the disclosure's requiredLevel (2 for SEALED),
 *      floors at 1, and leaves a non-disclosure (proof-request) approval at level 1.
 *   2. flow: EvidenceService.handle over SEALED artefacts → GRANTED with a PIN (was denied); a DenyGate still
 *      denies; the minted graph carries the level-2 approval.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-forge-sealed.ts
 */
import { createHash } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
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
let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-forge-sealed-e2e';
  const config = { ...base, dataRoot: `${base.dataRoot}-forge-sealed` };

  step('gate unit — the Signet gate scales the proof-of-human level to the disclosure requiredLevel');
  const gate = new PinGate('4242', '4242');
  const sealedApproval = await gate.approve({ requester: 'did:x', disclosure: { claim: 'c', evidenceRoot: 'r', requiredLevel: 2, reason: 'x' } });
  check('a SEALED (requiredLevel 2) approval attests level 2', sealedApproval?.level === 2);
  const medApproval = await gate.approve({ requester: 'did:x', disclosure: { claim: 'c', evidenceRoot: 'r', requiredLevel: 1, reason: 'x' } });
  check('a MEDIUM (requiredLevel 1) approval attests level 1', medApproval?.level === 1);
  const proofReqApproval = await gate.approve({ requester: 'did:x', challengeDid: 'did:challenge' });
  check('a non-disclosure (proof-request) approval stays at level 1', proofReqApproval?.level === 1);
  check('a wrong PIN still denies', (await new PinGate('4242', 'nope').approve({ requester: 'did:x', disclosure: { claim: 'c', evidenceRoot: 'r', requiredLevel: 2, reason: 'x' } })) === null);

  step('flow — a forge over SEALED evidence is GRANTED with a Signet PIN (was "level 1 below required 2")');
  const warden = await openKeymaster('warden', config, pass);
  const witness = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  const sovId = await ensureIdentity(sovereign, config);

  const delSchema = await ensureDelegationSchema(warden);
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const delCred = await issueDelegation(warden, witnessId.did, delSchema, { kinds: ['location'], validUntil: oneYear });
  await new DelegationStore(warden).record(witnessId.did, delCred);

  const store = new VaultStore(warden.dataFolder);
  for (const [i, day] of ['2026-02-04', '2026-03-11', '2026-04-20'].entries()) {
    await store.put({
      id: hex(`sealed-loc-${i}`),
      kind: 'location',
      observedAt: `${day}T09:00:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.SEALED, // the whole point — the drawn-on evidence is SEALED
      ciphertext: hex(`ct-${i}`),
      metadata: { witnessedBy: witnessId.did },
    });
  }

  const makeApprover = (g: ApprovalGate): SovereignApprover => {
    const handler = makeSovereignHandler(sovereign, g);
    return { async requestApproval(req) { return (await handler(req, wardenId.did)) as ApprovalResponseMessage; } };
  };
  const req: EvidenceRequest = {
    type: 'hearthold/evidence-request',
    version: PROTOCOL_VERSION,
    claim: 'Resided in FR during 2026-H1',
    disclosureMode: 'ATTESTATION',
    spec: { kind: 'location', from: '2026-01-01', to: '2026-06-30', structured: { type: 'residence', country: 'FR' } },
    subjectDid: sovId.did,
  };

  const denied = await new EvidenceService(warden, { ...config, sovereignDid: sovId.did }, makeApprover(new DenyGate())).handle(req, witnessId.did, true);
  check('a declined Signet → denied (fail closed, unchanged)', denied.status === 'denied');

  const granted = await new EvidenceService(warden, { ...config, sovereignDid: sovId.did }, makeApprover(new PinGate('4242', '4242'))).handle(req, witnessId.did, true);
  if (granted.status !== 'granted') process.stdout.write(`    reason: ${granted.status === 'denied' ? granted.reason : 'n/a'}\n`);
  // GRANTED is itself the proof the level-2 approval verified: pre-fix this SEALED forge failed the internal
  // `hp.level >= requiredLevel` check ("level 1 below required 2") and returned denied.
  check('a SEALED forge is GRANTED with the escalated Signet approval', granted.status === 'granted');
  check('a real forged scroll was minted (credentialDid)', granted.status === 'granted' && typeof granted.credentialDid === 'string' && granted.credentialDid.startsWith('did:'));

  process.stdout.write(
    failures === 0
      ? '\n✓ forge-sealed: the Signet gate scales the level to requiredLevel; a SEALED forge is approvable, not refused\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-forge-sealed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
