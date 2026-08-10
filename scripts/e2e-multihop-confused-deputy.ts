/**
 * e2e (Phase 5B graduation): the WIRED multi-hop chain invocation — adversarial suite + the Sovereign's
 * kill-switch. A real two-issuer chain (Sovereign → Emissary → sub-agent), invoked through the Warden's live
 * reference monitor (`handleInvocation` → `resolveChainInvocation`), must GRANT within the leaf grant and
 * REFUSE every confused-deputy variant the parity bar (docs/multihop-delegation.md) names:
 *
 *   happy · replay · foreign holder · stale challenge · omitted hop · over-attenuation · ★ revoked intermediate
 *
 * The ★ case is flaxscrip's priority: revoking an ANCESTOR hop kills the whole subtree at the next invocation.
 * We never loosen the monitor to make a refusal green.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-multihop-confused-deputy.ts
 */
import { randomUUID } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  mintRootCapability,
  delegateCapability,
  verifyCapabilityChain,
  issueVc,
  discloseChain,
  normalizeCaveats,
  ensureCapabilityStatusContext,
  allocateIndex,
  revokeStatusIndex,
  STATUS_LIST_LENGTH,
  PROTOCOL_VERSION,
  Sensitivity,
  type Caveats,
  type CapabilityInvocation,
  type KeymasterHandle,
  type EvidenceResponse,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService } from '@hearthold/warden/evidence';
import { ChallengeStore } from '@hearthold/warden/challenge-store';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const reasonOf = (r: EvidenceResponse): string => (r.status === 'denied' ? (r.reason ?? '') : '');

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-multihop-e2e';
  const reg = config.registry;
  const VAULT = 'hearthold:vault';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const subagent = await openKeymaster('verifier', config, pass); // the third-party sub-agent (leaf holder)
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const emiId = await ensureIdentity(emissary, config);
  const subId = await ensureIdentity(subagent, config);
  await warden.keymaster.setCurrentId(wardenId.name);

  // ── Mint a real two-issuer chain, each hop with its OWN revocation status ──────────────────────────────
  // Root: Sovereign issues, holder = Emissary (may invoke + re-delegate). Status in the SOVEREIGN's list.
  const sovStatus = await ensureCapabilityStatusContext(sovereign, sovId.name, config);
  const rootIdx = (await allocateIndex(sovereign, sovId.name, sovStatus.allocationRecord, randomUUID(), STATUS_LIST_LENGTH)).index;
  const root = await mintRootCapability({
    issuer: sovereign,
    issuerName: sovId.name,
    holder: emiId.did,
    capability: {
      invocationTarget: VAULT,
      authority: { operations: ['prove', 'submit'], resources: [VAULT] },
      caveats: { ceiling: Sensitivity.SEALED, owner: sovId.did, status: { statusListCredential: sovStatus.statusListCredential, statusListIndex: rootIdx } },
    },
    registry: reg,
  });

  // Child: Emissary DELEGATES onward to the sub-agent — narrower (prove-only, LOW, location). Status in the
  // EMISSARY's list (each delegator revokes what it issued).
  const emiStatus = await ensureCapabilityStatusContext(emissary, emiId.name, config);
  const childIdx = (await allocateIndex(emissary, emiId.name, emiStatus.allocationRecord, randomUUID(), STATUS_LIST_LENGTH)).index;
  const childCaveats: Caveats = {
    ceiling: Sensitivity.LOW,
    owner: sovId.did,
    kinds: ['location'],
    status: { statusListCredential: emiStatus.statusListCredential, statusListIndex: childIdx },
  };
  const child = await delegateCapability({
    issuer: emissary,
    issuerName: emiId.name,
    parent: root,
    holder: subId.did,
    child: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: childCaveats },
    registry: reg,
  });
  line(`\nchain: Sovereign(${sovId.did.slice(0, 16)}…) → Emissary(${emiId.did.slice(0, 16)}…) → sub-agent(${subId.did.slice(0, 16)}…)`);
  check('two-issuer chain minted (root counter 0, child counter 1)', root.issued.counter === 0 && child.issued.counter === 1);

  // ── The Warden serves the reference monitor over an owner-scoped vault ─────────────────────────────────
  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-fr', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });
  const cfg = { ...config, sovereignDid: sovId.did };
  const evidence = new EvidenceService(warden, cfg);
  const challenges = new ChallengeStore(warden, config.registry, sovId.did);
  const fullDisclosure = (): Record<string, unknown> => discloseChain(child, root);

  // Drive one chain invocation through the live monitor. Signs the holder proof with `holderName` (may differ
  // from the true holder — the foreign-holder attack) over a Warden-minted challenge (or a supplied stale one).
  async function invoke(opts: {
    leafVcDid: string;
    disclosed: Record<string, unknown>;
    holderKm: KeymasterHandle;
    holderName: string;
    fromDid: string;
    txn?: string;
    staleChallenge?: string;
  }): Promise<EvidenceResponse> {
    const challenge = opts.staleChallenge ?? (await challenges.mintForPurpose('invocation'));
    const txn = opts.txn ?? randomUUID();
    await opts.holderKm.keymaster.setCurrentId(opts.holderName);
    const holderProof = await opts.holderKm.keymaster.addProof(
      { type: 'hearthold/chain-holder-proof', challenge, leafVcDid: opts.leafVcDid, txn },
      opts.holderName,
    );
    const inv = {
      type: 'hearthold/invocation',
      version: PROTOCOL_VERSION,
      chain: { leafVcDid: opts.leafVcDid, disclosed: opts.disclosed, holderProof },
      act: { action: 'prove', target: 'hearthold:vault:location', nonce: randomUUID(), txn, args: { claim: 'resided in FR', spec: { kind: 'location' } } },
    } as unknown as CapabilityInvocation;
    await warden.keymaster.setCurrentId(wardenId.name);
    return evidence.handleInvocation(inv, opts.fromDid, challenges.gate('invocation'));
  }

  const leaf = { leafVcDid: child.issued.vcDid, holderKm: subagent, holderName: subId.name, fromDid: subId.did };

  line('\n════ HAPPY: the sub-agent invokes within its attenuated grant ════');
  const aTxn = randomUUID();
  const a = await invoke({ ...leaf, disclosed: fullDisclosure(), txn: aTxn });
  check('GRANTED — chain verified, holder proven, evidence minted', a.status === 'granted', reasonOf(a) || a.status);

  line('\n════ ADVERSARIAL: the parity bar ════');
  const rep = await invoke({ ...leaf, disclosed: fullDisclosure(), txn: aTxn }); // fresh challenge, SPENT txn
  check('DENIED — replay of a spent txn', rep.status === 'denied' && /replay|spent/.test(reasonOf(rep)), reasonOf(rep));

  const foreign = await invoke({ ...leaf, disclosed: fullDisclosure(), holderKm: emissary, holderName: emiId.name }); // signed by the Emissary, not the leaf holder
  check('DENIED — holder proof not signed by the chain-attested leaf holder', foreign.status === 'denied' && /leaf holder/.test(reasonOf(foreign)), reasonOf(foreign));

  const stale = await invoke({ ...leaf, disclosed: fullDisclosure(), staleChallenge: `stale:${randomUUID()}` });
  check('DENIED — holder proof did not answer a fresh Warden-minted challenge', stale.status === 'denied' && /challenge/.test(reasonOf(stale)), reasonOf(stale));

  const omitted = await invoke({ ...leaf, disclosed: { [child.issued.vcDid]: discloseChain(child)[child.issued.vcDid] } }); // root hop omitted
  check('DENIED — an omitted hop disclosure', omitted.status === 'denied' && /chain invalid|disclos/.test(reasonOf(omitted)), reasonOf(omitted));

  // Over-attenuation: raw-mint (bypass the issuance guard) a child of root that WIDENS authority. Give it a
  // resolvable status (Sovereign's list) so the SUBSET check — not the status check — is what refuses it.
  const forgedIdx = (await allocateIndex(sovereign, sovId.name, sovStatus.allocationRecord, randomUUID(), STATUS_LIST_LENGTH)).index;
  const forged = await issueVc({
    issuer: sovereign,
    issuerName: sovId.name,
    holder: subId.did,
    authoritySet: { operations: ['prove', 'submit', 'exfiltrate'], resources: [VAULT, 'secret-scope'] },
    caveats: normalizeCaveats({ ...childCaveats, status: { statusListCredential: sovStatus.statusListCredential, statusListIndex: forgedIdx } }),
    parent: root.issued,
    registry: reg,
    skipSubsetGuard: true,
  });
  const over = await invoke({
    ...leaf,
    leafVcDid: forged.vcDid,
    disclosed: { [forged.vcDid]: { authoritySet: forged.authoritySet, salt: forged.salt, caveats: forged.caveats }, ...discloseChain(root) },
  });
  check('DENIED — over-attenuation (child widens the parent authority)', over.status === 'denied' && /chain invalid/.test(reasonOf(over)), reasonOf(over));

  // Kinds-widening (bounded-kinds escape): the child hop grants kinds:['location']; a grandchild that ADDS a
  // kind ('book') the parent never granted must be REFUSED by the verifier's caveat-narrowing (audit fix).
  const gcKinds = await issueVc({
    issuer: subagent,
    issuerName: subId.name,
    holder: subId.did,
    authoritySet: { operations: ['prove'], resources: [VAULT] },
    caveats: normalizeCaveats({ ceiling: Sensitivity.LOW, owner: sovId.did, kinds: ['location', 'book'] }),
    parent: child.issued,
    registry: reg,
    skipSubsetGuard: true,
  });
  const kw = await verifyCapabilityChain(gcKinds.vcDid, {
    keymaster: warden,
    expectedRootIssuer: sovId.did,
    disclosed: { [gcKinds.vcDid]: { authoritySet: gcKinds.authoritySet, salt: gcKinds.salt, caveats: gcKinds.caveats }, ...discloseChain(child, root) },
    requireFullDisclosure: true,
  });
  check('DENIED — kinds-widening (a child adds a witness kind the parent never granted)', !kw.ok && kw.check === '(caveats)', kw.reason ?? '');

  line('\n════ ★ THE KILL-SWITCH: the Sovereign revokes the ROOT hop ════');
  await revokeStatusIndex(sovereign, sovId.name, sovStatus.statusListCredential, rootIdx);
  const killed = await invoke({ ...leaf, disclosed: fullDisclosure() });
  check('★ DENIED — revoking an ancestor hop kills the subtree at the next invocation', killed.status === 'denied' && /revoked/.test(reasonOf(killed)), reasonOf(killed));

  line(`\n${failures === 0 ? '✅ MULTI-HOP CHAIN INVOCATION — parity + kill-switch, end to end' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
