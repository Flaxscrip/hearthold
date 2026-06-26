/**
 * End-to-end test of the Hearthold witness→store→receipt round-trip over the HTTP/Tailscale
 * transport (no dmail, no notices, no registry footprint).
 *
 *   Warden serves on loopback  →  Witness connects (challenge/response → session)
 *   →  Witness seals an observation in-band  →  POST /submit
 *   →  Warden unseals → classifies → stores  →  returns receipt
 *
 * Reuses the identities under .hearthold-e2e (run after e2e-delegation).
 *
 * Run:  npm run e2e:submission
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  acceptDelegation,
  WardenClient,
  Sensitivity,
  type KeymasterHandle,
} from '@hearthold/core';
import { WardenServer } from '@hearthold/warden/server';
import { WardenService } from '@hearthold/warden/service';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';

let failures = 0;
function check(label: string, ok: boolean): void {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
}
function step(msg: string): void {
  process.stdout.write(`\n▸ ${msg}\n`);
}

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(
    `Hearthold submission e2e (HTTP transport)\n  gatekeeper: ${config.gatekeeperUrl}\n  data:       ${DATA_ROOT}\n`,
  );

  step('Open agents');
  const warden: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const witness: KeymasterHandle = await openKeymaster('witness', config, PASSPHRASE);
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  check('warden + witness ready', wardenId.did.startsWith('did:') && witnessId.did.startsWith('did:'));

  step('Ensure the Witness holds a valid delegation');
  const schemaDid = await ensureDelegationSchema(warden);
  const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  const delegationDid = await issueDelegation(warden, witnessId.did, schemaDid, {
    kinds: ['event', 'location', 'activity'],
    validUntil,
  });
  const accepted = await acceptDelegation(witness, delegationDid);
  check('delegation issued + accepted', accepted === true);

  step('Warden serves on loopback');
  const server = new WardenServer(warden);
  const { addr, port } = await server.listen('127.0.0.1', 0);
  const baseUrl = `http://${addr}:${port}`;
  check(`listening at ${baseUrl}`, port > 0);

  try {
    step('Witness connects (challenge/response → session)');
    const client = new WardenClient(witness, baseUrl);
    await client.connect();
    check('session established', client.connectedWardenDid === wardenId.did);

    step('Witness submits a sealed observation');
    const receipt = await client.submit({
      kind: 'location',
      observedAt: new Date().toISOString(),
      payload: { place: 'Paris, FR', lat: 48.8566, lon: 2.3522, note: 'e2e observation' },
    });
    check(`receipt returned, artefact ${receipt.artefactId.slice(0, 20)}…`, receipt.artefactId.length > 0);
    check(`quarantined by default (SEALED=${Sensitivity.SEALED})`, receipt.assignedSensitivity === Sensitivity.SEALED);

    step('Vault holds the (encrypted) artefact');
    const vault = await new WardenService(warden).listArtefacts();
    const stored = vault.find((a) => a.id === receipt.artefactId);
    check('artefact present in vault', stored != null);
    check('stored payload is ciphertext, not plaintext', !!stored && !stored.ciphertext.includes('Paris'));
  } finally {
    await server.close();
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
