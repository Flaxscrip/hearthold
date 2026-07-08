/**
 * e2e: card-face hydration — the Warden's local render surface for the Sevenfold Table.
 *
 * Every render crosses the release ladder. Proves the sensitivity × tier matrix: PUBLIC/LOW hydrate at
 * STANDING; MEDIUM refused at STANDING, granted at CHALLENGE; HIGH needs HUMAN; SEALED refused below
 * MULTIFACTOR. Refusals are first-class `granted:false` outcomes (the Table renders obsidian), NEVER
 * thrown. A granted face round-trips its content; a real failure (unknown artefact) does throw.
 *
 * Live (needs the Archon node). Run:  npm run e2e:face-hydration
 */
import { createHash } from 'node:crypto';

import { loadConfig, openKeymaster, ensureIdentity, sealForWarden, contentId, Sensitivity, AuthzTier } from '@hearthold/core';
import { VaultStore, type Artefact } from '@hearthold/warden/store';
import { hydrateCardFace } from '@hearthold/warden/face';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const warden = await openKeymaster('warden', config, 'hearthold-e2e-face');
  const wid = await ensureIdentity(warden, config);
  const store = new VaultStore(warden.dataFolder);

  // Seal one artefact at each sensitivity; the face is the text we can assert on round-trip.
  const ids: Record<number, string> = {};
  for (const s of [Sensitivity.PUBLIC, Sensitivity.LOW, Sensitivity.MEDIUM, Sensitivity.HIGH, Sensitivity.SEALED]) {
    const text = `face@${s}`;
    const ciphertext = await sealForWarden(warden, wid.did, JSON.stringify({ text }));
    const id = contentId(ciphertext, warden.cipher);
    const artefact: Artefact = {
      id,
      kind: 'document',
      observedAt: new Date('2026-07-08').toISOString(),
      storedAt: new Date('2026-07-08').toISOString(),
      sensitivity: s,
      ciphertext,
      metadata: {},
    };
    await store.put(artefact);
    ids[s] = id;
  }

  const hydrate = (s: number, tier: AuthzTier) => hydrateCardFace(warden, { artefactId: ids[s] as string, tier });
  const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

  process.stdout.write('▸ PUBLIC / LOW hydrate at STANDING\n');
  const pub = await hydrate(Sensitivity.PUBLIC, AuthzTier.STANDING);
  assert(pub.granted && decode(pub.face) === 'face@0', 'PUBLIC face hydrates at STANDING and round-trips');
  const low = await hydrate(Sensitivity.LOW, AuthzTier.STANDING);
  assert(low.granted, 'LOW face hydrates at STANDING');

  process.stdout.write('\n▸ MEDIUM: refused at STANDING (obsidian), granted at CHALLENGE\n');
  const medStanding = await hydrate(Sensitivity.MEDIUM, AuthzTier.STANDING);
  assert(!medStanding.granted, 'MEDIUM is REFUSED at STANDING (granted:false — the Table draws obsidian)');
  assert(!medStanding.granted && typeof medStanding.reason === 'string', 'the refusal carries a reason, and was not thrown');
  const medChallenge = await hydrate(Sensitivity.MEDIUM, AuthzTier.CHALLENGE);
  assert(medChallenge.granted && decode(medChallenge.face) === 'face@2', 'MEDIUM hydrates at CHALLENGE');

  process.stdout.write('\n▸ HIGH needs HUMAN; SEALED needs MULTIFACTOR\n');
  assert(!(await hydrate(Sensitivity.HIGH, AuthzTier.CHALLENGE)).granted, 'HIGH refused at CHALLENGE');
  assert((await hydrate(Sensitivity.HIGH, AuthzTier.HUMAN)).granted, 'HIGH hydrates at HUMAN');
  assert(!(await hydrate(Sensitivity.SEALED, AuthzTier.HUMAN)).granted, 'SEALED refused below MULTIFACTOR (at HUMAN)');
  const sealed = await hydrate(Sensitivity.SEALED, AuthzTier.MULTIFACTOR);
  assert(sealed.granted && decode(sealed.face) === 'face@4', 'SEALED hydrates only at MULTIFACTOR');

  process.stdout.write('\n▸ Refusal is not an error; a real failure is\n');
  assert(!(await hydrate(Sensitivity.SEALED, AuthzTier.STANDING)).granted, 'SEALED@STANDING refuses without throwing');
  let threw = false;
  try {
    await hydrateCardFace(warden, { artefactId: 'did:cid:' + createHash('sha256').update('nope').digest('hex'), tier: AuthzTier.MULTIFACTOR });
  } catch {
    threw = true;
  }
  assert(threw, 'an unknown artefact THROWS (a real error, distinct from a refusal)');

  process.stdout.write('\n✓ Face hydration: the ladder governs every render; refusals are obsidian, not errors\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-face-hydration: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
