/**
 * e2e: the Emissary submission path authorizes by a PRESENTED delegation credential — same VC
 * challenge/response pattern as invocation, replacing the local ACL lookup. Live against Archon.
 *
 * A legit delegation presentation yields {kinds, member} + proven holder; forgeries are refused: no
 * presentation, a self-issued delegation (not signed by the trusted Warden), and a captured presentation
 * replayed by a non-holder. Run:
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-delegation-presentation.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  acceptDelegation,
  requestProof,
  presentProof,
} from '@hearthold/core';
import { DelegationStore } from '@hearthold/warden/delegations';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-delegation-presentation-e2e';

  const warden = await openKeymaster('warden', config, pass);
  const emissary = await openKeymaster('emissary', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const attacker = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const emiId = await ensureIdentity(emissary, config);
  const sovId = await ensureIdentity(sovereign, config);
  const atkId = await ensureIdentity(attacker, config);

  const oneMonth = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  const schema = await ensureDelegationSchema(warden);

  // Legit: the Warden delegates location-submission to the Emissary on behalf of the Sovereign (member).
  const delegationDid = await issueDelegation(warden, emiId.did, schema, { kinds: ['location', 'event'], validUntil: oneMonth, member: sovId.did });
  await acceptDelegation(emissary, delegationDid);

  const store = new DelegationStore(warden);
  const present = async (holder: typeof emissary): Promise<string> => {
    const challenge = await requestProof(warden, { schema, trustedIssuers: [wardenId.did] });
    return presentProof(holder, challenge);
  };

  line('\n════ the delegation presentation ════');
  const ok = await store.verifyDelegationPresentation(await present(emissary), emiId.did);
  check('legit presentation → kinds + member + proven holder', ok.ok && ok.kinds.includes('location') && ok.member === sovId.did, ok.ok ? '' : ok.reason);

  line('\n════ forgeries the Warden must refuse ════');
  const a1 = await store.verifyDelegationPresentation('', emiId.did);
  check('no presentation → refused', !a1.ok, a1.ok ? '' : a1.reason);

  // The attacker self-issues a delegation to itself (issuer = attacker, not the trusted Warden).
  const forged = await issueDelegation(attacker, atkId.did, schema, { kinds: ['location'], validUntil: oneMonth });
  await acceptDelegation(attacker, forged);
  const a2 = await store.verifyDelegationPresentation(await present(attacker), atkId.did);
  check('self-issued delegation (not signed by the trusted Warden) → refused', !a2.ok, a2.ok ? '' : a2.reason);

  const a3 = await store.verifyDelegationPresentation(await present(emissary), atkId.did);
  check("captured legit presentation replayed by a non-holder → refused", !a3.ok, a3.ok ? '' : a3.reason);

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
