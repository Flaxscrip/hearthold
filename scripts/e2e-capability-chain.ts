/**
 * e2e (Phase 1): a Sovereign ROOT capability over the vault, an attenuated DELEGATION to the Emissary, and
 * the verifier enforcing attenuation across BOTH authority and caveats — live against Archon.
 *
 * PASS = the happy chain ACCEPTS, an over-authority/over-caveat delegation is REFUSED at issuance, and a
 * forged (raw-minted, bypassing delegateCapability) widening is REJECTED by the verifier. We never loosen
 * the verifier to make a rejection green. Run (clean data root + local registry):
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 \
 *   HEARTHOLD_REGISTRY=local node --experimental-strip-types scripts/e2e-capability-chain.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  mintRootCapability,
  delegateCapability,
  verifyCapabilityChain,
  discloseChain,
  issueVc,
  normalizeCaveats,
  Sensitivity,
  type KeymasterHandle,
  type Caveats,
} from '@hearthold/core';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-capability-e2e';
  const reg = config.registry;

  const sovereign = await openKeymaster('sovereign', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const verifierNode = await openKeymaster('verifier', config, pass);
  const sovId = await ensureIdentity(sovereign, config);
  const emiId = await ensureIdentity(emissary, config);
  await ensureIdentity(verifierNode, config);

  const VAULT = 'hearthold:vault';
  line(`\n════ Sovereign ${sovId.did.slice(0, 24)}… mints a ROOT capability over ${VAULT} ════`);

  // Root: broad authority, SEALED ceiling, owner = the Sovereign, held by the Sovereign.
  const root = await mintRootCapability({
    issuer: sovereign,
    issuerName: sovId.name,
    holder: sovId.did,
    capability: {
      invocationTarget: VAULT,
      authority: { operations: ['prove', 'submit'], resources: [VAULT] },
      caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did },
    },
    registry: reg,
  });
  check('root minted (counter 0)', root.issued.counter === 0, root.issued.vcDid.slice(0, 28) + '…');

  // Registry hygiene: the capability Asset DID is born `local`.
  const registryOf = async (did: string): Promise<string | undefined> =>
    (await sovereign.keymaster.resolveDID(did)).didDocumentRegistration?.registry;
  check('root capability born on `local`', (await registryOf(root.issued.vcDid)) === 'local');

  // Delegate to the Emissary: narrow — only `prove`, ceiling MEDIUM, and ADD a consent discharge caveat.
  const emiCaveats: Caveats = {
    ceiling: Sensitivity.MEDIUM,
    owner: sovId.did,
    requiresDischarge: [{ by: sovId.did, predicate: 'cosign(act)' }],
  };
  const emiCap = await delegateCapability({
    issuer: sovereign,
    issuerName: sovId.name,
    parent: root,
    holder: emiId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: emiCaveats },
    registry: reg,
  });
  check('Emissary delegation minted (counter 1)', emiCap.issued.counter === 1);

  const V = { keymaster: verifierNode as KeymasterHandle, expectedRootIssuer: sovId.did };

  line('\n════ HAPPY: the verifier ACCEPTS the attenuated chain ════');
  const happy = await verifyCapabilityChain(emiCap.issued.vcDid, {
    ...V,
    disclosed: discloseChain(emiCap, root),
    orderedCaveats: [emiCap.capability.caveats, root.capability.caveats],
  });
  check('chain ACCEPTS (authority ⊆ + caveats narrow + signatures + lineage)', happy.ok, happy.reason ?? '');

  line('\n════ REFUSED AT ISSUANCE: an over-authority delegation ════');
  let threw = false;
  try {
    await delegateCapability({
      issuer: sovereign,
      issuerName: sovId.name,
      parent: emiCap, // parent grants only `prove`
      holder: emiId.did,
      child: { invocationTarget: VAULT, authority: { operations: ['prove', 'submit'], resources: [VAULT] }, caveats: emiCaveats },
      registry: reg,
    });
  } catch {
    threw = true;
  }
  check('delegateCapability REFUSES widening `prove`→`prove,submit`', threw);

  line('\n════ VERIFIER CATCHES a forged (raw-minted) authority widening ════');
  // Bypass delegateCapability: raw-mint a child of the Emissary hop that ADDS a resource, forcing past the
  // issuance guard. The verifier must REJECT at (⊆).
  // Issued by the EMISSARY (emiCap's holder) so it passes the delegator binding and reaches the (⊆) gate.
  const forgedAuth = await issueVc({
    issuer: emissary,
    issuerName: emiId.name,
    holder: emiId.did,
    authoritySet: { operations: ['prove'], resources: [VAULT, 'secret-scope'] },
    caveats: normalizeCaveats(emiCaveats),
    parent: emiCap.issued,
    registry: reg,
    skipSubsetGuard: true,
  });
  const authAttack = await verifyCapabilityChain(forgedAuth.vcDid, {
    ...V,
    disclosed: {
      [forgedAuth.vcDid]: { authoritySet: forgedAuth.authoritySet, salt: forgedAuth.salt, caveats: forgedAuth.caveats },
      ...discloseChain(emiCap, root),
    },
  });
  check('verifier REJECTS the authority widening', !authAttack.ok, authAttack.check ?? '');

  line('\n════ VERIFIER CATCHES a forged caveat widening (ceiling MEDIUM→HIGH) ════');
  // Authority stays a valid subset, but the caveat ceiling is raised above the parent. verifyAttenuationChain
  // alone would accept (authority ⊆); verifyCapabilityChain's caveat-narrowing pass must REJECT.
  const widenedCaveats: Caveats = { ceiling: Sensitivity.HIGH, owner: sovId.did, requiresDischarge: [{ by: sovId.did, predicate: 'cosign(act)' }] };
  const forgedCav = await issueVc({
    issuer: emissary,
    issuerName: emiId.name,
    holder: emiId.did,
    authoritySet: { operations: ['prove'], resources: [VAULT] },
    caveats: normalizeCaveats(widenedCaveats),
    parent: emiCap.issued,
    registry: reg,
  });
  const cavAttack = await verifyCapabilityChain(forgedCav.vcDid, {
    ...V,
    disclosed: {
      [forgedCav.vcDid]: { authoritySet: forgedCav.authoritySet, salt: forgedCav.salt, caveats: forgedCav.caveats },
      ...discloseChain(emiCap, root),
    },
    orderedCaveats: [widenedCaveats, emiCap.capability.caveats, root.capability.caveats],
  });
  check('verifier REJECTS the caveat widening', !cavAttack.ok && cavAttack.check === '(caveats)', cavAttack.reason ?? '');

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
