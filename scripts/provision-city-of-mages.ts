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
 * Then serve it:  HEARTHOLD_PASSPHRASE=… npm run warden -- control 4310
 * Guests: challenge/response login → session → get-doc/recall the public chronicle; a curator promotes to shared.
 */
import { loadConfig, openKeymaster, ensureIdentity, createRegistryGroup, grantAuthorization, selfSigner } from '@hearthold/core';
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
  // Self-governed assurance policy (Warden-signed): read/write clear at factor1 by default; raise a verb to
  // factor2 later with kb-govern/setKbAssurance so it steps up to a member's Signet.
  const policyAsset = await initKbAssurance(warden, config, KB, selfSigner(warden, wid.did));
  await store.put({
    kbId: KB,
    readGroup,
    writeGroup,
    policyAsset,
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
