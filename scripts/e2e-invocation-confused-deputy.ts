/**
 * e2e (RED TEST): the confused deputy, reproduced against the capability cure.
 *
 * Every case here is an ATTACK the Warden MUST refuse. Each sends an invocation whose `capability`
 * credentialSubject is an attacker-controlled wire object referencing a REAL leaf Asset DID, with the
 * commitment-bound `disclosed` map omitted (or the holder unproven). If any is GRANTED, finding A is
 * reproduced through the cure. The design doc (invocation.md) promises this file — it did not exist.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invocation-confused-deputy.ts
 */
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  mintRootCapability,
  delegateCapability,
  discloseChain,
  createStatusList,
  AUTHORIZATION_TYPE,
  PROTOCOL_VERSION,
  Sensitivity,
  type CapabilityInvocation,
  type HearthholdCapability,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService } from '@hearthold/warden/evidence';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
/** An attack PASSES the test only if it was DENIED. A GRANT is a live vulnerability. */
function mustDeny(name: string, status: string, reason = ''): void {
  const ok = status === 'denied';
  if (!ok) failures++;
  line(`${ok ? '✓ refused' : '✗ GRANTED (vulnerable)'} — ${name}${reason && ok ? ` [${reason}]` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-confused-deputy-e2e';
  const reg = config.registry;
  const VAULT = 'hearthold:vault';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const emissary = await openKeymaster('emissary', config, pass); // the LEGITIMATE holder
  const attacker = await openKeymaster('verifier', config, pass); // a hostile third party
  await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const emiId = await ensureIdentity(emissary, config);
  const atkId = await ensureIdentity(attacker, config);
  const cfg = { ...config, sovereignDid: sovId.did };

  // The victim's private data.
  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-victim', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.MEDIUM, ciphertext: 'secret', metadata: { witness: 'device-A' }, owner: sovId.did });

  const evidence = new EvidenceService(warden, cfg);

  // A REAL Sovereign-rooted leaf capability, legitimately delegated to the Emissary (MEDIUM, no discharge).
  const root = await mintRootCapability({
    issuer: sovereign, issuerName: sovId.name, holder: sovId.did,
    capability: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
    registry: reg,
  });
  const emiLeaf = await delegateCapability({
    issuer: sovereign, issuerName: sovId.name, parent: root, holder: emiId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did } },
    registry: reg,
  });

  // A second real leaf that REQUIRES a Signet discharge, and carries a revocation status.
  const { statusListCredential } = await createStatusList(sovereign, sovId.name, config);
  const emiSealed = await delegateCapability({
    issuer: sovereign, issuerName: sovId.name, parent: root, holder: emiId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did, requiresDischarge: [{ by: sovId.did, predicate: 'cosign(act)' }], status: { statusListCredential, statusListIndex: 99 } } },
    registry: reg,
  });

  const forge = (subject: HearthholdCapability, extra: Partial<CapabilityInvocation> = {}): CapabilityInvocation => ({
    type: 'hearthold/invocation', version: PROTOCOL_VERSION,
    capability: { type: ['VerifiableCredential', AUTHORIZATION_TYPE], credentialSubject: subject },
    act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn: randomUUID(), args: { claim: 'resided in FR', spec: { kind: 'location' } } },
    // NOTE: disclosed / orderedCaveats intentionally OMITTED — the attacker never held the capability.
    ...extra,
  });

  line('\n════ attacks the Warden must refuse (each references a REAL leaf DID) ════');

  // A1 — the headline: attacker forges the body, names itself controller, victim as owner, itself as audience.
  const a1 = await evidence.handleInvocation(forge({
    authorizationType: 'capability', id: emiLeaf.issued.vcDid, controller: atkId.did, invocationTarget: VAULT,
    authority: { operations: ['prove'], resources: [VAULT] },
    caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did, audience: atkId.did },
  }), atkId.did);
  mustDeny('forged body + omitted disclosure (finding A through the cure)', a1.status, a1.reason);

  // A2 — strip the discharge + status off a capability that requires them.
  const a2 = await evidence.handleInvocation(forge({
    authorizationType: 'capability', id: emiSealed.issued.vcDid, controller: atkId.did, invocationTarget: VAULT,
    authority: { operations: ['prove'], resources: [VAULT] },
    caveats: { ceiling: Sensitivity.MEDIUM, owner: sovId.did, audience: atkId.did }, // no requiresDischarge, no status
  }), atkId.did);
  mustDeny('stripped requiresDischarge + status (skips consent + revocation)', a2.status, a2.reason);

  // A3 — a legitimate holder (Emissary) but omitting the disclosure that binds authority/caveats.
  const a3 = await evidence.handleInvocation(forge({
    authorizationType: 'capability', id: emiLeaf.issued.vcDid, controller: emiId.did, invocationTarget: VAULT,
    authority: { operations: ['prove'], resources: [VAULT] },
    caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did }, // escalated ceiling, unbound
  }), emiId.did);
  mustDeny('legit holder escalating ceiling with no disclosure', a3.status, a3.reason);

  // Attacker's own challenge/response — proving control of their OWN DID must not help.
  const mkResponse = async (km: typeof attacker, idName: string): Promise<string> => {
    const challenge = await (warden.keymaster.createChallenge as (a?: unknown, o?: unknown) => Promise<string>)({ purpose: 'hearthold-invocation' }, { registry: reg });
    await km.keymaster.setCurrentId(idName);
    return (km.keymaster.createResponse as (c: string, o?: unknown) => Promise<string>)(challenge, { registry: reg });
  };
  const honest = discloseChain(emiLeaf, root); // a CAPTURED, honest disclosure for the real leaf

  // A4 — replay a captured honest disclosure, forging the controller, with NO holder proof.
  const a4 = await evidence.handleInvocation(forge(
    { ...emiLeaf.capability, controller: atkId.did },
    { disclosed: honest },
  ), atkId.did);
  mustDeny('captured honest disclosure + forged controller + no holder proof', a4.status, a4.reason);

  // A5 — same, but the attacker proves control of THEIR OWN DID (not the chain-bound holder).
  const a5 = await evidence.handleInvocation(forge(
    { ...emiLeaf.capability, controller: atkId.did },
    { disclosed: honest, holderProof: await mkResponse(attacker, atkId.name) },
  ), atkId.did);
  mustDeny('honest disclosure + holder proof for the ATTACKER (not the holder)', a5.status, a5.reason);

  line(`\n${failures === 0 ? '✅ ALL ATTACKS REFUSED' : `❌ ${failures} ATTACK(S) SUCCEEDED — vulnerability live`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
