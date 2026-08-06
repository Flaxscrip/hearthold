/**
 * e2e (Phase 2a): the invocation REFERENCE MONITOR — verifyInvocation — live against Archon.
 *
 * The deliverable is the monitor authorizing a legitimate invocation and DENYING every violation it is
 * designed to catch: wrong holder, action outside the capability, over-ceiling, replay, and a consent gap
 * (needsDischarge) that is then satisfied by a bound discharge. Designation is authority — the owner and the
 * approver come from the CAPABILITY, never the request. Run (clean data root + local registry):
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 \
 *   HEARTHOLD_REGISTRY=local node --experimental-strip-types scripts/e2e-invocation.ts
 */
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  mintRootCapability,
  delegateCapability,
  discloseChain,
  verifyInvocation,
  MemorySpentTxnStore,
  AUTHORIZATION_TYPE,
  PROTOCOL_VERSION,
  Sensitivity,
  type CapabilityHandle,
  type CapabilityInvocation,
  type InvocationContext,
  type Discharge,
  type KeymasterHandle,
} from '@hearthold/core';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const cred = (h: CapabilityHandle): CapabilityInvocation['capability'] => ({
  type: ['VerifiableCredential', AUTHORIZATION_TYPE],
  credentialSubject: h.capability,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function proveHolder(challenger: any, holder: any, holderName: string, reg: string): Promise<string> {
  const challenge = await challenger.keymaster.createChallenge({ purpose: 'hearthold-invocation' }, { registry: reg });
  await holder.keymaster.setCurrentId(holderName);
  return holder.keymaster.createResponse(challenge, { registry: reg });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-invocation-e2e';
  const reg = config.registry;
  const VAULT = 'hearthold:vault';

  const sovereign = await openKeymaster('sovereign', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const verifierNode = await openKeymaster('verifier', config, pass);
  const sovId = await ensureIdentity(sovereign, config);
  const emiId = await ensureIdentity(emissary, config);
  await ensureIdentity(verifierNode, config);

  line(`\n════ Sovereign root over ${VAULT} → Emissary delegation (prove ≤ MEDIUM) ════`);
  const root = await mintRootCapability({
    issuer: sovereign,
    issuerName: sovId.name,
    holder: sovId.did,
    capability: { invocationTarget: VAULT, authority: { operations: ['prove', 'submit'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did } },
    registry: reg,
  });
  const emi = await delegateCapability({
    issuer: sovereign,
    issuerName: sovId.name,
    parent: root,
    holder: emiId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
    registry: reg,
  });

  const spent = new MemorySpentTxnStore();
  const emiProof = await proveHolder(verifierNode, emissary, emiId.name, reg);
  const base: Omit<InvocationContext, 'fromDid' | 'sensitivity'> = {
    keymaster: verifierNode as KeymasterHandle,
    expectedRootIssuer: sovId.did,
    disclosed: discloseChain(emi, root),
    spent,
  };
  const invoke = (action: string, txn: string): CapabilityInvocation => ({
    type: 'hearthold/invocation',
    version: PROTOCOL_VERSION,
    capability: cred(emi),
    act: { action, target: VAULT, nonce: randomUUID(), txn },
    holderProof: emiProof,
  });

  line('\n════ the monitor ════');
  const t1 = randomUUID();
  const happy = await verifyInvocation(invoke('prove', t1), { ...base, fromDid: emiId.did, sensitivity: Sensitivity.MEDIUM });
  check('AUTHORIZES a legitimate prove invocation', happy.allow && happy.owner === sovId.did, happy.reason);

  const replay = await verifyInvocation(invoke('prove', t1), { ...base, fromDid: emiId.did, sensitivity: Sensitivity.MEDIUM });
  check('DENIES replay (txn already spent)', !replay.allow && /replay|spent/.test(replay.reason), replay.reason);

  const wrongHolder = await verifyInvocation(invoke('prove', randomUUID()), { ...base, fromDid: sovId.did, sensitivity: Sensitivity.MEDIUM });
  check('DENIES a non-holder (holder binding)', !wrongHolder.allow && /holder/.test(wrongHolder.reason), wrongHolder.reason);

  const badAction = await verifyInvocation(invoke('submit', randomUUID()), { ...base, fromDid: emiId.did, sensitivity: Sensitivity.MEDIUM });
  check("DENIES an action outside the capability ('submit')", !badAction.allow && /action/.test(badAction.reason), badAction.reason);

  const overCeiling = await verifyInvocation(invoke('prove', randomUUID()), { ...base, fromDid: emiId.did, sensitivity: Sensitivity.SEALED });
  check('DENIES a SEALED disclosure through a MEDIUM ceiling', !overCeiling.allow && /ceiling|sensitivity/.test(overCeiling.reason), overCeiling.reason);

  line('\n════ consent discharge (macaroon third-party caveat) ════');
  const emiD = await delegateCapability({
    issuer: sovereign,
    issuerName: sovId.name,
    parent: root,
    holder: emiId.did,
    child: {
      invocationTarget: VAULT,
      authority: { operations: ['prove'], resources: [VAULT] },
      caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did, requiresDischarge: [{ by: sovId.did, predicate: 'cosign(act)' }] },
    },
    registry: reg,
  });
  const baseD = { ...base, disclosed: discloseChain(emiD, root) };
  const tD = randomUUID();
  const invD: CapabilityInvocation = { type: 'hearthold/invocation', version: PROTOCOL_VERSION, capability: cred(emiD), act: { action: 'prove', target: VAULT, nonce: randomUUID(), txn: tD }, holderProof: emiProof };

  const undischarged = await verifyInvocation(invD, { ...baseD, fromDid: emiId.did, sensitivity: Sensitivity.MEDIUM });
  check('a required consent is a needsDischarge gap, not a denial', !undischarged.allow && (undischarged.needsDischarge?.length ?? 0) === 1, undischarged.reason);

  // The DESIGNATED party (the Sovereign) signs a discharge BOUND to this act's txn.
  await sovereign.keymaster.setCurrentId(sovId.name);
  const discharge = (await sovereign.keymaster.addProof({ by: sovId.did, txn: tD, predicate: 'cosign(act)', level: 3 }, sovId.name)) as Discharge;
  const dischargedInv: CapabilityInvocation = { ...invD, discharges: [discharge] };
  const discharged = await verifyInvocation(dischargedInv, { ...baseD, fromDid: emiId.did, sensitivity: Sensitivity.MEDIUM });
  check('AUTHORIZES once a bound discharge from the designated Signet is present', discharged.allow, discharged.reason);

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
