/**
 * End-to-end test of the Hearthold witness→store→receipt round-trip over the **DIDComm v2**
 * transport (no notices, no registry footprint, authcrypt-authenticated sender).
 *
 *   Warden serves a DIDComm receive loop  ←  Emissary seals + sends a submission
 *   →  Warden authorizes (delegation) → unseals → classifies → stores  →  replies with a receipt
 *   →  Emissary correlates the reply by thid.
 *
 * Requires the node's DIDComm service enabled. Uses the identities under .hearthold-e2e.
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
  sealForWarden,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
  Sensitivity,
  type KeymasterHandle,
  type WitnessSubmission,
} from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { DelegationStore } from '@hearthold/warden/delegations';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { QuarantineClassifier } from '@hearthold/warden/classifier';

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
  process.stdout.write(
    `Hearthold submission e2e (DIDComm transport)\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`,
  );

  step('Open agents');
  const warden: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const witness: KeymasterHandle = await openKeymaster('emissary', config, PASSPHRASE);
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  check('warden + witness ready', wardenId.did.startsWith('did:') && witnessId.did.startsWith('did:'));

  step('Issue + record a delegation for the Emissary');
  const schemaDid = await ensureDelegationSchema(warden);
  const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  const delegationDid = await issueDelegation(warden, witnessId.did, schemaDid, {
    kinds: ['event', 'location', 'activity'],
    validUntil,
  });
  await new DelegationStore(warden).record(witnessId.did, delegationDid);
  check('delegation issued + recorded', delegationDid.startsWith('did:'));

  step('Warden serves over DIDComm');
  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, config.nodeUrl);
  await wardenTransport.ready();
  const stop = await wardenTransport.serve(
    makeWardenHandler(
      new WardenService(warden, new QuarantineClassifier()),
      new DelegationStore(warden),
    ),
    { pollMs: 1000 },
  );
  check('warden endpoint published + serving', true);

  try {
    step('Emissary seals + submits over DIDComm');
    const witnessTransport = new DidCommTransport(witness, IDENTITY_NAME.emissary, config.nodeUrl);
    await witnessTransport.ready();
    const ciphertext = await sealForWarden(
      witness,
      wardenId.did,
      JSON.stringify({ place: 'Paris, FR', lat: 48.8566, note: 'e2e observation' }),
    );
    const submission: WitnessSubmission = {
      type: 'hearthold/witness-submission',
      version: PROTOCOL_VERSION,
      kind: 'location',
      observedAt: new Date().toISOString(),
      ciphertext,
    };
    const reply = await witnessTransport.request(wardenId.did, submission, { pollMs: 1000 });
    check('reply is a submission receipt', reply.type === 'hearthold/submission-receipt');
    const receipt = reply.type === 'hearthold/submission-receipt' ? reply : null;
    check(`quarantined by default (SEALED=${Sensitivity.SEALED})`, receipt?.assignedSensitivity === Sensitivity.SEALED);

    step('Vault holds the (encrypted) artefact');
    const vault = await new WardenService(warden).listArtefacts();
    const stored = vault.find((a) => a.id === receipt?.artefactId);
    check('artefact present in vault', stored != null);
    check('stored payload is ciphertext, not plaintext', !!stored && !stored.ciphertext.includes('Paris'));
  } finally {
    stop();
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
