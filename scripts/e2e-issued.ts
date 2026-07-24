/**
 * End-to-end test of the `issued` foundation: a third-party issuer issues a credential to the
 * Sovereign, the Sovereign accepts it, and it is recorded as an `issued` evidence leaf in the vault.
 *
 *   Sphere (external issuer) ──issues "Raid-Lead, Example Sphere"──► Sovereign (subject)
 *   Sovereign accepts ──► recordIssuedCredential ──► `issued` leaf in the Warden's vault
 *
 * (The "sphere" issuer reuses the Emissary identity as a stand-in external party — in production this
 * is a real sphere-manager DID. The accept mechanics are identical regardless of issuer.)
 *
 * Run:  npm run e2e:issued
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  acceptCredential,
  recordIssuedCredential,
  agentDataFolder,
  IssuedStore,
} from '@hearthold/core';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  const vaultFolder = agentDataFolder(config, 'warden');
  process.stdout.write(`Hearthold issued-credential e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision the issuer (sphere) + the Sovereign');
  const sphere = await openKeymaster('emissary', config, PASSPHRASE); // stand-in external issuer
  const sovereign = await openKeymaster('sovereign', config, PASSPHRASE);
  const sphereId = await ensureIdentity(sphere, config);
  const sovereignId = await ensureIdentity(sovereign, config);
  check('sphere + sovereign ready', sphereId.did.startsWith('did:') && sovereignId.did.startsWith('did:'));

  step('Sphere issues a membership credential to the Sovereign');
  const bound = await sphere.keymaster.bindCredential(sovereignId.did, {
    claims: { type: 'SphereMembership', sphere: 'Example Sphere', role: 'Raid-Lead' },
  });
  const credDid = await sphere.keymaster.issueCredential(bound);
  check(`credential issued ${credDid.slice(0, 28)}…`, credDid.startsWith('did:'));

  step('Sovereign accepts + records the issued leaf');
  const accepted = await acceptCredential(sovereign, credDid);
  check('sovereign accepted the credential', accepted === true);
  const leaf = await recordIssuedCredential(sovereign, credDid, vaultFolder);
  check('trust class is issued', leaf.trustClass === 'issued');
  check('issuer = the sphere', leaf.issuer === sphereId.did);
  check('subject = the Sovereign', leaf.subject === sovereignId.did);
  check('credentialType = SphereMembership', leaf.credentialType === 'SphereMembership');
  check('claim role = Raid-Lead', leaf.claims.role === 'Raid-Lead');
  check('descriptionSource = issuer-asserted', leaf.descriptionSource === 'issuer-asserted');

  step('Leaf is in the vault');
  const stored = await new IssuedStore(vaultFolder).get(credDid);
  check('issued leaf present in vault', stored != null);

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
