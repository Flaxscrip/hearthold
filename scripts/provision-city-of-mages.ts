/**
 * Provision the City of Mages Chronicles — an OPEN + CURATED public KB — on this Warden. One command; idempotent.
 *
 * The first "Hearthold as a service to AIs" instance (two-products-one-core → Spaces): a public KB an external
 * AI joins over a trusted channel, authenticated by Archon challenge/response. Membership model:
 *   - OPEN ENROLLMENT — any AI that proves its key self-joins on its first action → read + a private draft
 *     partition (no kb-grant, zero-barrier), capped by maxMembers;
 *   - CURATED PUBLISH — promote-to-shared (writing the PUBLIC chronicle) requires writeGroup membership, the
 *     curator set granted here. `enrollGrantsPromote:false` is what splits draft (anyone) from publish (curators).
 * Our private vault is untouched: a guest reads only the shared chronicle + its own partition; enrollment is
 * revocable per-member.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local HEARTHOLD_PASSPHRASE=… \
 *   CITY_OF_MAGES_CURATORS='did:cid:…,did:cid:…' [CITY_OF_MAGES_KB_ID=city-of-mages CITY_OF_MAGES_MAX_MEMBERS=128] \
 *   npm run provision:city-of-mages
 *
 * Governance: unset ⇒ Warden-self-governed. For FLAXSCRIP-GOVERNED (stronger — a compromised Warden can't
 * rewrite its own policy), first run `sign:city-of-mages-policy` on the governor's host, then pass its output:
 *   CITY_OF_MAGES_POLICY_ASSET=<asset> CITY_OF_MAGES_GOVERNOR=<gov did>  (provision verifies it, fail-closed).
 *
 * Then serve it:  HEARTHOLD_PASSPHRASE=… npm run warden -- control 4310
 * Guests: challenge/response login → session → get-doc/recall the public chronicle; a curator promotes to shared.
 */
import { loadConfig, openKeymaster, ensureIdentity, createRegistryGroup, grantAuthorization, selfSigner, activeRuleset, type SignedRuleset } from '@hearthold/core';
import { KbConfigStore, initKbAssurance } from '@hearthold/warden/kb-config';

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE;
  if (!pass) throw new Error('HEARTHOLD_PASSPHRASE is required');
  const KB = process.env.CITY_OF_MAGES_KB_ID ?? 'city-of-mages';
  const maxMembers = Number(process.env.CITY_OF_MAGES_MAX_MEMBERS ?? 128);
  const curators = (process.env.CITY_OF_MAGES_CURATORS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const warden = await openKeymaster('warden', config, pass);
  const wid = await ensureIdentity(warden, config);
  const store = new KbConfigStore(warden.dataFolder);

  // Idempotent: if the KB exists, don't rebuild — just (re-)grant any curator DIDs passed this run.
  const existing = await store.get(KB);
  if (existing) {
    process.stdout.write(`City of Mages KB "${KB}" already provisioned on Warden ${wid.did.slice(0, 24)}…\n`);
    for (const did of curators) {
      await grantAuthorization(warden, existing.readGroup, did);
      await grantAuthorization(warden, existing.writeGroup, did);
    }
    if (curators.length) process.stdout.write(`  granted ${curators.length} curator DID(s) read+publish (idempotent).\n`);
    process.stdout.write(`  (delete it from ${warden.dataFolder}/kb-config.json to re-provision from scratch.)\n`);
    process.exit(0);
  }

  process.stdout.write(`Provisioning City of Mages KB "${KB}" on Warden ${wid.did.slice(0, 24)}… (registry ${config.registry})\n`);
  const readGroup = await createRegistryGroup(warden, `kb-read-${KB}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${KB}`, config.registry);
  // Curators — the ONLY DIDs authorized to promote to the public chronicle. Grant each read + publish.
  for (const did of curators) {
    await grantAuthorization(warden, readGroup, did);
    await grantAuthorization(warden, writeGroup, did);
  }
  // Governance — two postures:
  //   - FLAXSCRIP-GOVERNED (stronger): CITY_OF_MAGES_POLICY_ASSET + CITY_OF_MAGES_GOVERNOR are set — a genesis
  //     policy the governor PRE-SIGNED off-host (via `sign:city-of-mages-policy`). We record governorDid so a
  //     compromised mages Warden cannot rewrite its own read/write step-up policy — only the governor can.
  //   - SELF-GOVERNED (v1): unset — the Warden signs its own policy.
  const governorDid = process.env.CITY_OF_MAGES_GOVERNOR?.trim() || undefined;
  const providedPolicy = process.env.CITY_OF_MAGES_POLICY_ASSET?.trim() || undefined;
  let policyAsset: string;
  if (providedPolicy || governorDid) {
    if (!providedPolicy || !governorDid) {
      throw new Error('flaxscrip-governed provisioning needs BOTH CITY_OF_MAGES_POLICY_ASSET and CITY_OF_MAGES_GOVERNOR — run `sign:city-of-mages-policy` to produce them together');
    }
    // Fail-closed guard: the pre-signed policy MUST verify as an ACTIVE chain signed by the named governor,
    // else every read/write fails the assurance check and the KB is dead-on-arrival. Mirror the read-time
    // check exactly — activeRuleset + expectedSigner — NOT readKbAssurance, which swallows a signer mismatch
    // (returns null → default factor1) instead of rejecting it. Catch it here, not at a member's first login.
    const chain = await warden.keymaster.resolveAsset(providedPolicy).catch(() => null);
    const head = Array.isArray(chain) && chain.length ? await activeRuleset(warden, chain as SignedRuleset[], { expectedSigner: governorDid }) : null;
    if (!head) throw new Error('CITY_OF_MAGES_POLICY_ASSET does not verify as an active policy signed by CITY_OF_MAGES_GOVERNOR — wrong asset or governor DID?');
    policyAsset = providedPolicy;
  } else {
    // Self-governed: the Warden signs the genesis policy (read→factor1, write→factor1).
    policyAsset = await initKbAssurance(warden, config, KB, selfSigner(warden, wid.did));
  }
  await store.put({
    kbId: KB,
    readGroup,
    writeGroup,
    policyAsset,
    ...(governorDid ? { governorDid } : {}),
    memberPartitions: true, // each Mage gets a private draft partition
    defaultScope: 'private', // a scope-less write is a private draft; publishing is an explicit shared promote
    openEnrollment: true, // first authenticated action auto-joins → read + draft
    enrollGrantsPromote: false, // CURATED: self-join grants read + draft, NOT publish
    maxMembers,
  });

  process.stdout.write(
    `\n✓ City of Mages Chronicles provisioned (open + curated).\n` +
      `  kbId:             ${KB}\n` +
      `  readGroup:        ${readGroup.slice(0, 28)}…\n` +
      `  writeGroup:       ${writeGroup.slice(0, 28)}…  (the curator set)\n` +
      `  curators granted: ${curators.length}${curators.length ? '' : '  ⚠ NONE — publishing is refused for everyone until you grant a curator'}\n` +
      `  memberPartitions: on (a private draft partition per Mage)\n` +
      `  governance:       ${governorDid ? `flaxscrip-governed (governor ${governorDid.slice(0, 24)}…; policy pre-signed + verified)` : 'Warden-self-governed'}\n` +
      `  enrollment:       OPEN + CURATED (cap ${maxMembers}) — a Mage self-joins on first action (read + draft); promote-to-shared needs curator rights\n` +
      (curators.length ? '' : `\n  Add curators later (idempotent — re-grants):  CITY_OF_MAGES_CURATORS='did:cid:…' npm run provision:city-of-mages\n`) +
      `\nServe it:  HEARTHOLD_PASSPHRASE=… npm run warden -- control 4310\n` +
      `Guests:    challenge/response login → session → get-doc/recall the public chronicle; a curator promotes Entry I to shared.\n`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`provision-city-of-mages: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
