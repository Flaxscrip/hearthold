/**
 * End-to-end test of cross-node credential delivery over DIDComm (the MECHANISM).
 *
 *   Issuer (warden id) issues a membership VC to the Subject (sovereign id)
 *   Subject serves `makeCredentialDeliveryHandler` over DIDComm
 *   Issuer `deliverCredential(...)` ──► ships VC + schema ops ──► Subject imports + accepts ──► ack
 *
 * This runs against a SINGLE Archon node (issuer + subject share a registry), so it proves the Hearthold
 * protocol mechanism: package → deliver → import → accept → ack, the KB-ingest hook, idempotency, the
 * use-id guard, and the cache rule at the message level (default ships NO issuer ops). The TRUE
 * no-shared-registry case (where the import + issuer-throwaway actually bite) is proven by Aegis's
 * two-node harness (`~/isolation/aegis/deploy/two-node/harness-credential-exchange.sh`), whose PHASE-4
 * seam calls this same `deliverCredential`.
 *
 * Run:  npm run e2e:credential-delivery
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  deliverCredential,
  makeCredentialDeliveryHandler,
  DidCommTransport,
  IDENTITY_NAME,
  type KeymasterHandle,
} from '@hearthold/core';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e-cred-delivery');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const MEMBERSHIP_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { type: { type: 'string' }, club: { type: 'string' }, tier: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
} as const;

async function issueMembership(
  issuer: KeymasterHandle,
  subjectDid: string,
  tier: string,
): Promise<{ credDid: string; schemaDid: string }> {
  await issuer.keymaster.setCurrentId(IDENTITY_NAME.warden);
  const schemaDid = await issuer.keymaster.createSchema(MEMBERSHIP_SCHEMA);
  const bound = await issuer.keymaster.bindCredential(subjectDid, {
    schema: schemaDid,
    claims: { type: 'Membership', club: 'Hearthold', tier },
  });
  const credDid = await issuer.keymaster.issueCredential(bound, { schema: schemaDid });
  return { credDid, schemaDid };
}

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(
    `Hearthold credential-delivery e2e\n  node: ${config.nodeUrl}\n  registry: ${config.registry}\n  data: ${DATA_ROOT}\n`,
  );

  step('Provision issuer (warden id) + subject (sovereign id)');
  const issuer: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const subject: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE);
  await ensureIdentity(issuer, config);
  const subjectId = await ensureIdentity(subject, config);
  check('identities ready', subjectId.did.startsWith('did:'));

  // Subject serves the credential-delivery handler; issuer gets a transport to deliver over.
  const subjectTransport = new DidCommTransport(subject, IDENTITY_NAME.sovereign, config.nodeUrl);
  await subjectTransport.ready();
  const issuerTransport = new DidCommTransport(issuer, IDENTITY_NAME.warden, config.nodeUrl);
  await issuerTransport.ready();

  step('Default delivery (no issuer ops — the cache rule): deliver → import → accept → ack');
  {
    const { credDid } = await issueMembership(issuer, subjectId.did, 'gold');
    // A stand-in VC→KB bridge, injected so core stays warden-free; returns a fake artefact id.
    const handler = makeCredentialDeliveryHandler(subject, IDENTITY_NAME.sovereign, {
      onAccepted: async (_h, cred) => `artefact:${cred.slice(-8)}`,
    });
    const stop = await subjectTransport.serve(handler, { pollMs: 1000 });
    try {
      const ack = await deliverCredential(issuer, IDENTITY_NAME.warden, issuerTransport, subjectId.did, credDid);
      if (!ack.accepted) process.stdout.write(`    reason: ${ack.reason}\n`);
      check('ack.accepted = true', ack.accepted === true);
      check('cache rule: default ships NO issuer throwaway', ack.type === 'hearthold/credential-delivery-ack');
      check('KB-ingest hook fired (artefactId returned)', ack.ingestedArtefactId === `artefact:${credDid.slice(-8)}`);

      await subject.keymaster.setCurrentId(IDENTITY_NAME.sovereign);
      const held = await subject.keymaster.listCredentials();
      check('subject now holds the credential', held.includes(credDid));

      const vc = await subject.keymaster.getCredential(credDid);
      const issuerInfo = await issuer.keymaster.fetchIdInfo(IDENTITY_NAME.warden);
      check('verification anchors on the issuer DID (resolved fresh)', vc?.issuer === issuerInfo.did);
      check('disclosed tier = gold', vc?.credentialSubject?.tier === 'gold');

      // Re-deliver the same credential — accepting an already-held VC is idempotent, not an error.
      const ack2 = await deliverCredential(issuer, IDENTITY_NAME.warden, issuerTransport, subjectId.did, credDid);
      check('re-delivery is idempotent (accepted again)', ack2.accepted === true);
    } finally {
      stop();
    }
  }

  step('Opt-in throwaway path: includeIssuerOps ships the issuer as a refreshable stopgap');
  {
    const { credDid } = await issueMembership(issuer, subjectId.did, 'silver');
    const handler = makeCredentialDeliveryHandler(subject, IDENTITY_NAME.sovereign);
    const stop = await subjectTransport.serve(handler, { pollMs: 1000 });
    try {
      const ack = await deliverCredential(issuer, IDENTITY_NAME.warden, issuerTransport, subjectId.did, credDid, {
        includeIssuerOps: true,
      });
      check('accepted with issuer throwaway shipped', ack.accepted === true);
      await subject.keymaster.setCurrentId(IDENTITY_NAME.sovereign);
      check('subject holds it', (await subject.keymaster.listCredentials()).includes(credDid));
    } finally {
      stop();
    }
  }

  step('use-id guard: an unknown issuer identity fails loud (not silently as whoever is current)');
  {
    let threw = false;
    try {
      await deliverCredential(issuer, 'no-such-identity', issuerTransport, subjectId.did, 'did:test:x');
    } catch {
      threw = true;
    }
    check('deliverCredential rejects a typo’d issuer name', threw);
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
