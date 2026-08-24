/**
 * Provision a HATPro KB on this Warden — a shared, member-partitioned, OPEN-ENROLLMENT KB the AI-augmented
 * HATPro app points at (docs/agent-family.md, HATPRO brief). One command; idempotent.
 *
 *   - a shared partition = the public travel pool (`scope:'shared'` contributions);
 *   - a private partition per member = their traveler profile (member-key sealed);
 *   - OPEN ENROLLMENT: a visitor's first authenticated action auto-joins (grant + partition) — no `kb-grant`,
 *     zero-barrier onboarding — capped by `maxMembers`.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local HEARTHOLD_PASSPHRASE=… \
 *   [HATPRO_KB_ID=hatpro HATPRO_MAX_MEMBERS=10000] npm run provision:hatpro
 *
 * Then serve it:  HEARTHOLD_PASSPHRASE=… npm run warden -- control 4310   (the app talks to :4310).
 */
import { loadConfig, openKeymaster, ensureIdentity, createRegistryGroup, selfSigner } from '@hearthold/core';
import { KbConfigStore, initKbAssurance } from '@hearthold/warden/kb-config';

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE;
  if (!pass) throw new Error('HEARTHOLD_PASSPHRASE is required');
  const KB = process.env.HATPRO_KB_ID ?? 'hatpro';
  const maxMembers = Number(process.env.HATPRO_MAX_MEMBERS ?? 10000);

  const warden = await openKeymaster('warden', config, pass);
  const wid = await ensureIdentity(warden, config);
  const store = new KbConfigStore(warden.dataFolder);

  const existing = await store.get(KB);
  if (existing) {
    process.stdout.write(
      `HATPro KB "${KB}" already provisioned on Warden ${wid.did.slice(0, 24)}…\n` +
        `  memberPartitions=${existing.memberPartitions} openEnrollment=${existing.openEnrollment} maxMembers=${existing.maxMembers}\n` +
        `  (delete it from ${warden.dataFolder}/kb-config.json to re-provision.)\n`,
    );
    process.exit(0);
  }

  process.stdout.write(`Provisioning HATPro KB "${KB}" on Warden ${wid.did.slice(0, 24)}… (registry ${config.registry})\n`);
  const readGroup = await createRegistryGroup(warden, `kb-read-${KB}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${KB}`, config.registry);
  // Assurance policy (Sovereign-signed, self-governed here): read/write clear at factor1 by default; raise a
  // sensitive verb to factor2 later with kb-govern/setKbAssurance so it steps up to the visitor's Signet.
  const policyAsset = await initKbAssurance(warden, config, KB, selfSigner(warden, wid.did));
  await store.put({
    kbId: KB,
    readGroup,
    writeGroup,
    policyAsset,
    memberPartitions: true, // each visitor gets a private profile partition
    defaultScope: 'private', // a scope-less contribution is the visitor's own profile; scope:'shared' → the public pool
    openEnrollment: true, // first authenticated action auto-joins — zero-barrier onboarding
    maxMembers, // cap new members (partition-flood guard)
  });

  process.stdout.write(
    `\n✓ HATPro KB provisioned.\n` +
      `  kbId:            ${KB}\n` +
      `  readGroup:       ${readGroup.slice(0, 28)}…\n` +
      `  writeGroup:      ${writeGroup.slice(0, 28)}…\n` +
      `  memberPartitions: on (private profile per visitor)\n` +
      `  defaultScope:    private (scope:'shared' → the public travel pool)\n` +
      `  openEnrollment:  on (cap ${maxMembers}) — a visitor's first authenticated action auto-joins\n` +
      `\nServe it:  HEARTHOLD_PASSPHRASE=… npm run warden -- control 4310\n` +
      `The app: challenge/response login → session → contribute (private = profile, shared = pool) → recall.\n`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`provision-hatpro-kb: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
