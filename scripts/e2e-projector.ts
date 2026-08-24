/**
 * End-to-end test of the **Emissary-as-projector** path (milestone W).
 *
 *   Sphere issues "Raid-Lead" (with schema) ──► Sovereign accepts
 *   Sovereign serves over DIDComm (Signet PIN gates each disclosure)
 *   Emissary serves over DIDComm as the world-facing projector — relays proof-requests to the Sovereign
 *   Verifier: requestProof → send proof-request to the WITNESS → Emissary relays to Sovereign →
 *             Signet approves + presents → Emissary carries the proof-presentation back → verifyProof
 *
 * The verifier never addresses the Sovereign directly: it talks to the Emissary (the Mage that
 * projects), and the Emissary relays to the Signet (the First Person that approves). Four real
 * identities: sphere = warden, holder/approver = sovereign, projector = witness, relying party = verifier.
 *
 * Run:  npm run e2e:projector
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  acceptCredential,
  requestProof,
  verifyProof,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
  type KeymasterHandle,
  type HearthholdMessage,
  type ProofPresentationMessage,
} from '@hearthold/core';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';
import { makeEmissaryProjectorHandler } from '@hearthold/emissary/handler';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const SPHERE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { type: { type: 'string' }, sphere: { type: 'string' }, role: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
} as const;

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(`Hearthold Emissary-as-projector e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision sphere (issuer), sovereign (holder/approver), witness (projector), verifier');
  const sphere: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const sovereign: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE);
  const witness: KeymasterHandle = await openKeymaster('emissary', config, PASSPHRASE);
  const verifier: KeymasterHandle = await openKeymaster('verifier', config, PASSPHRASE);
  const sphereId = await ensureIdentity(sphere, config);
  const sovereignId = await ensureIdentity(sovereign, config);
  const witnessId = await ensureIdentity(witness, config);
  await ensureIdentity(verifier, config);
  check('identities ready', sphereId.did.startsWith('did:') && witnessId.did.startsWith('did:'));

  step('Sphere issues a membership credential to the Sovereign');
  const schemaDid = await sphere.keymaster.createSchema(SPHERE_SCHEMA);
  const bound = await sphere.keymaster.bindCredential(sovereignId.did, {
    schema: schemaDid,
    claims: { type: 'SphereMembership', sphere: 'Example Sphere', role: 'Raid-Lead' },
  });
  const credDid = await sphere.keymaster.issueCredential(bound, { schema: schemaDid });
  await acceptCredential(sovereign, credDid);
  check('sovereign holds the credential', credDid.startsWith('did:'));

  const PIN = '1234';
  // Publish each participant's endpoint up front.
  const verifierTransport = new DidCommTransport(verifier, IDENTITY_NAME.verifier, config.nodeUrl);
  await verifierTransport.ready();
  await new DidCommTransport(witness, IDENTITY_NAME.emissary, config.nodeUrl).ready();
  await new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl).ready();

  // The verifier asks the WITNESS (projector), never the Sovereign directly.
  const askProof = async (): Promise<HearthholdMessage> => {
    const challengeDid = await requestProof(verifier, { schema: schemaDid, trustedIssuers: [sphereId.did] });
    return verifierTransport.request(
      witnessId.did,
      { type: 'hearthold/proof-request', version: PROTOCOL_VERSION, challengeDid },
      { pollMs: 1000 },
    );
  };

  step('Approve case: verifier → Emissary relays → Signet PIN approves → present → verify');
  {
    const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    const witT = new DidCommTransport(witness, IDENTITY_NAME.emissary, config.nodeUrl);
    const stopSov = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, PIN)), { pollMs: 1000 });
    const stopWit = await witT.serve(makeEmissaryProjectorHandler(witT, sovereignId.did), { pollMs: 1000 });
    try {
      const reply = await askProof();
      check('got a proof-presentation (carried by the Emissary)', reply.type === 'hearthold/proof-presentation');
      const pres = reply.type === 'hearthold/proof-presentation' ? (reply as ProofPresentationMessage) : null;
      check('carries the Signet proof-of-human (pin, level 1)', pres?.humanProof?.method === 'pin' && pres?.humanProof?.level === 1);
      const result = await verifyProof(verifier, pres?.responseDid ?? '', {
        trustedIssuers: [sphereId.did],
        requiredClaims: { role: 'Raid-Lead' },
      });
      check('proof verifies', result.ok === true);
      check('disclosed role = Raid-Lead', result.disclosed[0]?.claims.role === 'Raid-Lead');
    } finally {
      stopWit();
      stopSov();
    }
  }

  step('Deny case: Signet declines (wrong PIN) → Emissary carries the decline back');
  {
    const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    const witT = new DidCommTransport(witness, IDENTITY_NAME.emissary, config.nodeUrl);
    const stopSov = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, 'wrong')), { pollMs: 1000 });
    const stopWit = await witT.serve(makeEmissaryProjectorHandler(witT, sovereignId.did), { pollMs: 1000 });
    try {
      const reply = await askProof();
      check('disclosure is declined (error carried back)', reply.type === 'hearthold/error');
    } finally {
      stopWit();
      stopSov();
    }
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
