/**
 * End-to-end test of the **Witness-as-projector** path (milestone W).
 *
 *   Guild issues "Raid-Lead" (with schema) ──► Sovereign accepts
 *   Sovereign serves over DIDComm (Signet PIN gates each disclosure)
 *   Witness serves over DIDComm as the world-facing projector — relays proof-requests to the Sovereign
 *   Verifier: requestProof → send proof-request to the WITNESS → Witness relays to Sovereign →
 *             Signet approves + presents → Witness carries the proof-presentation back → verifyProof
 *
 * The verifier never addresses the Sovereign directly: it talks to the Witness (the Mage that
 * projects), and the Witness relays to the Signet (the First Person that approves). Four real
 * identities: guild = warden, holder/approver = sovereign, projector = witness, relying party = verifier.
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
import { makeWitnessProjectorHandler } from '@hearthold/witness/handler';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const GUILD_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { type: { type: 'string' }, guild: { type: 'string' }, role: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
} as const;

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(`Hearthold Witness-as-projector e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision guild (issuer), sovereign (holder/approver), witness (projector), verifier');
  const guild: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const sovereign: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE);
  const witness: KeymasterHandle = await openKeymaster('witness', config, PASSPHRASE);
  const verifier: KeymasterHandle = await openKeymaster('verifier', config, PASSPHRASE);
  const guildId = await ensureIdentity(guild, config);
  const sovereignId = await ensureIdentity(sovereign, config);
  const witnessId = await ensureIdentity(witness, config);
  await ensureIdentity(verifier, config);
  check('identities ready', guildId.did.startsWith('did:') && witnessId.did.startsWith('did:'));

  step('Guild issues a membership credential to the Sovereign');
  const schemaDid = await guild.keymaster.createSchema(GUILD_SCHEMA);
  const bound = await guild.keymaster.bindCredential(sovereignId.did, {
    schema: schemaDid,
    claims: { type: 'GuildMembership', guild: 'Drake Island', role: 'Raid-Lead' },
  });
  const credDid = await guild.keymaster.issueCredential(bound, { schema: schemaDid });
  await acceptCredential(sovereign, credDid);
  check('sovereign holds the credential', credDid.startsWith('did:'));

  const PIN = '1234';
  // Publish each participant's endpoint up front.
  const verifierTransport = new DidCommTransport(verifier, IDENTITY_NAME.verifier, config.nodeUrl);
  await verifierTransport.ready();
  await new DidCommTransport(witness, IDENTITY_NAME.witness, config.nodeUrl).ready();
  await new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl).ready();

  // The verifier asks the WITNESS (projector), never the Sovereign directly.
  const askProof = async (): Promise<HearthholdMessage> => {
    const challengeDid = await requestProof(verifier, { schema: schemaDid, trustedIssuers: [guildId.did] });
    return verifierTransport.request(
      witnessId.did,
      { type: 'hearthold/proof-request', version: PROTOCOL_VERSION, challengeDid },
      { pollMs: 1000 },
    );
  };

  step('Approve case: verifier → Witness relays → Signet PIN approves → present → verify');
  {
    const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    const witT = new DidCommTransport(witness, IDENTITY_NAME.witness, config.nodeUrl);
    const stopSov = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, PIN)), { pollMs: 1000 });
    const stopWit = await witT.serve(makeWitnessProjectorHandler(witT, sovereignId.did), { pollMs: 1000 });
    try {
      const reply = await askProof();
      check('got a proof-presentation (carried by the Witness)', reply.type === 'hearthold/proof-presentation');
      const pres = reply.type === 'hearthold/proof-presentation' ? (reply as ProofPresentationMessage) : null;
      check('carries the Signet proof-of-human (pin, level 1)', pres?.humanProof?.method === 'pin' && pres?.humanProof?.level === 1);
      const result = await verifyProof(verifier, pres?.responseDid ?? '', {
        trustedIssuers: [guildId.did],
        requiredClaims: { role: 'Raid-Lead' },
      });
      check('proof verifies', result.ok === true);
      check('disclosed role = Raid-Lead', result.disclosed[0]?.claims.role === 'Raid-Lead');
    } finally {
      stopWit();
      stopSov();
    }
  }

  step('Deny case: Signet declines (wrong PIN) → Witness carries the decline back');
  {
    const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    const witT = new DidCommTransport(witness, IDENTITY_NAME.witness, config.nodeUrl);
    const stopSov = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, 'wrong')), { pollMs: 1000 });
    const stopWit = await witT.serve(makeWitnessProjectorHandler(witT, sovereignId.did), { pollMs: 1000 });
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
