/**
 * Sign the City of Mages genesis governance policy — the Sovereign step for a FLAXSCRIP-GOVERNED chronicle.
 *
 * Run this where the GOVERNOR's wallet lives (flaxscrip's host), with the gatekeeper URL pointed at the mages
 * node's public gatekeeper. It signs the genesis assurance ruleset with the governor's OWN key and creates the
 * policy asset NATIVELY on that gatekeeper — so a compromised mages Warden cannot rewrite the KB's read/write
 * step-up policy; only the governor can, by signing a new head. The Signet signs ONCE, here — curators then
 * publish under this policy with their own signatures; the governor is NOT in the per-publish path.
 *
 * Two-step by design (the governor signs off-host, the Warden provisions on its host):
 *   1. (this script, on the governor's host) → prints the policy-asset DID + the governor DID;
 *   2. hand both to provision:city-of-mages (on the Warden host):
 *        CITY_OF_MAGES_POLICY_ASSET=<asset> CITY_OF_MAGES_GOVERNOR=<gov did> CITY_OF_MAGES_CURATORS=<curator dids> \
 *        npm run provision:city-of-mages
 *
 *   HEARTHOLD_GATEKEEPER_URL=<mages gatekeeper> HEARTHOLD_REGISTRY=hyperswarm HEARTHOLD_PASSPHRASE=<gov wallet pass> \
 *   [CITY_OF_MAGES_KB_ID=city-of-mages CITY_OF_MAGES_GOVERNOR_WALLET=sovereign] \
 *   npm run sign:city-of-mages-policy
 *
 * (Fallback if the governor's wallet can't reach the mages gatekeeper endpoint: sign against any reachable
 *  gatekeeper on the SAME registry and let it gossip, or hand the signed asset to the Warden host to anchor.)
 */
import { loadConfig, openKeymaster, ensureIdentity, selfSigner } from '@hearthold/core';
import { initKbAssurance } from '@hearthold/warden/kb-config';

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE;
  if (!pass) throw new Error('HEARTHOLD_PASSPHRASE is required (the GOVERNOR wallet passphrase)');
  const KB = process.env.CITY_OF_MAGES_KB_ID ?? 'city-of-mages';
  const walletName = process.env.CITY_OF_MAGES_GOVERNOR_WALLET ?? 'sovereign';

  const gov = await openKeymaster(walletName, config, pass);
  const govId = await ensureIdentity(gov, config);

  process.stdout.write(`Signing the "${KB}" genesis governance policy as governor ${govId.did.slice(0, 24)}… (registry ${config.registry})\n`);
  // The governor SIGNS the genesis ruleset (read→factor1, write→factor1) and anchors it as an asset on its own
  // gatekeeper — the same call the Warden would self-sign, but signed by the governor so readers can pin it.
  const policyAsset = await initKbAssurance(gov, config, KB, selfSigner(gov, govId.did));

  process.stdout.write(
    `\n✓ Genesis policy signed + anchored on the gatekeeper.\n` +
      `  governor DID:  ${govId.did}\n` +
      `  policy asset:  ${policyAsset}\n` +
      `\nProvision with (on the Warden host):\n` +
      `  CITY_OF_MAGES_POLICY_ASSET=${policyAsset} \\\n` +
      `  CITY_OF_MAGES_GOVERNOR=${govId.did} \\\n` +
      `  CITY_OF_MAGES_CURATORS='<curator did:cid:…>' \\\n` +
      `  npm run provision:city-of-mages\n`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`sign-city-of-mages-policy: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
