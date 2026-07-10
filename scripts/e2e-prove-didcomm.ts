/**
 * End-to-end test of the prove flow **over DIDComm**.
 *
 *   Guild issues "Raid-Lead" (with schema) ──► Sovereign accepts
 *   Sovereign serves over DIDComm (presents proofs on request)
 *   Verifier: requestProof → send proof-request over DIDComm → Sovereign presents →
 *             proof-presentation reply → verifyProof
 *
 * Stand-in roles: guild = warden identity, holder = sovereign, verifier = witness.
 *
 * Run:  npm run e2e:prove-didcomm
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
  type ProofPresentationMessage,
} from '@hearthold/core';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';

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
  process.stdout.write(`Hearthold prove-over-DIDComm e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision guild (issuer), sovereign (holder), verifier');
  const guild: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const sovereign: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE);
  const verifier: KeymasterHandle = await openKeymaster('emissary', config, PASSPHRASE);
  const guildId = await ensureIdentity(guild, config);
  const sovereignId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);
  check('identities ready', guildId.did.startsWith('did:') && sovereignId.did.startsWith('did:'));

  step('Guild issues a membership credential to the Sovereign');
  const schemaDid = await guild.keymaster.createSchema(GUILD_SCHEMA);
  const bound = await guild.keymaster.bindCredential(sovereignId.did, {
    schema: schemaDid,
    claims: { type: 'GuildMembership', guild: 'Example Guild', role: 'Raid-Lead' },
  });
  const credDid = await guild.keymaster.issueCredential(bound, { schema: schemaDid });
  await acceptCredential(sovereign, credDid);
  check('sovereign holds the credential', credDid.startsWith('did:'));

  const PIN = '1234';
  const verifierTransport = new DidCommTransport(verifier, IDENTITY_NAME.emissary, config.nodeUrl);
  await verifierTransport.ready();
  await new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl).ready();

  const askProof = async (): Promise<import('@hearthold/core').HearthholdMessage> => {
    const challengeDid = await requestProof(verifier, { schema: schemaDid, trustedIssuers: [guildId.did] });
    return verifierTransport.request(
      sovereignId.did,
      { type: 'hearthold/proof-request', version: PROTOCOL_VERSION, challengeDid },
      { pollMs: 1000 },
    );
  };

  step('Approve case: Signet PIN approves → present + verify');
  {
    const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    const stop = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, PIN)), { pollMs: 1000 });
    try {
      const reply = await askProof();
      check('got a proof-presentation', reply.type === 'hearthold/proof-presentation');
      const pres = reply.type === 'hearthold/proof-presentation' ? (reply as ProofPresentationMessage) : null;
      check('carries a proof-of-human (pin, level 1)', pres?.humanProof?.method === 'pin' && pres?.humanProof?.level === 1);
      const result = await verifyProof(verifier, pres?.responseDid ?? '', {
        trustedIssuers: [guildId.did],
        requiredClaims: { role: 'Raid-Lead' },
      });
      check('proof verifies', result.ok === true);
      check('disclosed role = Raid-Lead', result.disclosed[0]?.claims.role === 'Raid-Lead');
    } finally {
      stop();
    }
  }

  step('Deny case: wrong PIN → disclosure declined, nothing presented');
  {
    const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
    const stop = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, 'wrong')), { pollMs: 1000 });
    try {
      const reply = await askProof();
      check('disclosure is declined (error reply)', reply.type === 'hearthold/error');
    } finally {
      stop();
    }
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
