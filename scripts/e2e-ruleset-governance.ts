/**
 * e2e: Signet governance of Warden policy — the hardening.
 *
 * Policy (a Ruleset chain) is signed by a governing Sovereign at the Signet, and readers PIN that
 * Sovereign's DID. Proves the security property: a compromised Warden cannot forge policy. The Warden
 * requests a signature over DIDComm (Signet gates on proof-of-human); on approval it's the Sovereign's
 * signature; a decline yields no signature; and a chain the Warden self-signed is REJECTED because the
 * reader expects the Sovereign.
 *
 * Live (needs the Archon node). Run:  npm run e2e:ruleset-governance
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  DidCommTransport,
  IDENTITY_NAME,
  RulesetAssurancePolicy,
  selfSigner,
  signRuleset,
  Sensitivity,
  type Ruleset,
} from '@hearthold/core';
import { makeDidcommRulesetSigner } from '@hearthold/warden/kb';
import { initKbAssurance, setKbAssurance, GovernanceDeclined } from '@hearthold/warden/kb-config';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-ruleset-gov';
  const PIN = '1379';
  const kbId = 'governed-kb';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass); // the governor
  const wardenId = await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);

  // Publish endpoints; the Warden reaches the Sovereign's Signet directly.
  await new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl).ready();
  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, config.nodeUrl);
  await wardenTransport.ready();

  const signer = makeDidcommRulesetSigner(wardenTransport, sovId.did, 30_000);
  const readRequired = (asset: string, action: string) =>
    new RulesetAssurancePolicy(warden, asset, sovId.did).requiredAssurance(action); // PIN the Sovereign

  process.stdout.write('▸ Warden requests a genesis policy; the Sovereign approves at the Signet\n');
  let policyAsset = '';
  {
    const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    const stop = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, PIN)), { pollMs: 1000 });
    policyAsset = await initKbAssurance(warden, config, kbId, signer);
    stop();
    assert(policyAsset.startsWith('did:'), 'the genesis policy is signed and anchored');
  }
  assert((await readRequired(policyAsset, 'write')) === 'factor1', 'governed policy reads correctly (write=factor1) when pinned to the Sovereign');

  process.stdout.write('\n▸ Warden requests a change (write→factor2); Sovereign approves\n');
  {
    const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    const stop = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, PIN)), { pollMs: 1000 });
    policyAsset = await setKbAssurance(warden, config, kbId, policyAsset, 'write', 'factor2', signer);
    stop();
  }
  assert((await readRequired(policyAsset, 'write')) === 'factor2', 'the Sovereign-signed change takes effect (write=factor2)');

  process.stdout.write('\n▸ The Sovereign DECLINES a change → no signature, policy unchanged\n');
  {
    const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    const stop = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, 'wrong')), { pollMs: 1000 });
    let declined = false;
    try {
      await setKbAssurance(warden, config, kbId, policyAsset, 'read', 'factor2', signer);
    } catch (e) {
      declined = e instanceof GovernanceDeclined;
    }
    stop();
    assert(declined, 'a declined signature throws GovernanceDeclined — the change does not happen');
  }

  process.stdout.write('\n▸ A COMPROMISED Warden self-signs a downgrade → REJECTED by governor pinning\n');
  const forged = await signRuleset(warden, {
    actor: kbId,
    actorKind: 'kb',
    resource: kbId,
    version: 1,
    previous: null,
    capabilities: { assurance: { read: 'factor1', write: 'factor1' } }, // downgrade write
    ceiling: Sensitivity.SEALED,
    status: 'active',
  } as Ruleset);
  const forgedAsset = await warden.keymaster.createAsset([forged], { registry: config.registry });
  const pinned = await new RulesetAssurancePolicy(warden, forgedAsset, sovId.did).requiredAssurance('write');
  assert(pinned === 'factor2', 'the Warden-forged policy is rejected (fail closed to factor2) — it is not the Sovereign');
  const unpinned = await new RulesetAssurancePolicy(warden, forgedAsset).requiredAssurance('write');
  assert(unpinned === 'factor1', 'without pinning the same forgery WOULD be accepted — proving pinning is what stops it');

  process.stdout.write('\n✓ Signet governance: the Sovereign signs policy at the Signet; pinning makes it forge-proof against a compromised Warden\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-ruleset-governance: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
