/**
 * End-to-end test of the prove flow for an `issued` claim.
 *
 *   Guild issues "Raid-Lead, Example Guild" (with a schema) ──► Sovereign accepts
 *   Verifier requests proof (schema + trusted issuer = the Guild)
 *   Sovereign presents ──► Verifier verifies: reads role=Raid-Lead, confirms issuer = the Guild
 *
 * Trust rests on the Guild's signature — the verifier trusts the Guild, not the Warden.
 * Stand-in roles: guild = warden identity, holder = sovereign, verifier = witness.
 *
 * Run:  npm run e2e:prove
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  acceptCredential,
  requestProof,
  presentProof,
  verifyProof,
  type KeymasterHandle,
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

const GUILD_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { type: { type: 'string' }, guild: { type: 'string' }, role: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
} as const;

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(`Hearthold prove e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision guild (issuer), sovereign (holder), verifier');
  const guild: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const sovereign: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE);
  const verifier: KeymasterHandle = await openKeymaster('witness', config, PASSPHRASE);
  const guildId = await ensureIdentity(guild, config);
  const sovereignId = await ensureIdentity(sovereign, config);
  await ensureIdentity(verifier, config);
  check('all three identities ready', guildId.did.startsWith('did:') && sovereignId.did.startsWith('did:'));

  step('Guild issues a membership credential (with schema) to the Sovereign');
  const schemaDid = await guild.keymaster.createSchema(GUILD_SCHEMA);
  const bound = await guild.keymaster.bindCredential(sovereignId.did, {
    schema: schemaDid,
    claims: { type: 'GuildMembership', guild: 'Example Guild', role: 'Raid-Lead' },
  });
  const credDid = await guild.keymaster.issueCredential(bound, { schema: schemaDid });
  await acceptCredential(sovereign, credDid);
  check('sovereign holds the guild credential', credDid.startsWith('did:'));

  step('Verifier trusts the Guild → requests, Sovereign presents, verifier verifies');
  const challenge = await requestProof(verifier, { schema: schemaDid, trustedIssuers: [guildId.did] });
  const response = await presentProof(sovereign, challenge);
  const result = await verifyProof(verifier, response, {
    trustedIssuers: [guildId.did],
    requiredClaims: { role: 'Raid-Lead' },
  });
  check('proof verifies', result.ok === true);
  check('responder is the Sovereign', result.responder === sovereignId.did);
  check('disclosed issuer = the Guild', result.disclosed[0]?.issuer === guildId.did);
  check('disclosed role = Raid-Lead', result.disclosed[0]?.claims.role === 'Raid-Lead');

  step('Negative: a verifier that does NOT trust the Guild gets nothing');
  const untrusted = await requestProof(verifier, {
    schema: schemaDid,
    trustedIssuers: [sovereignId.did], // trusts the wrong party — Sovereign issued nothing
  });
  const response2 = await presentProof(sovereign, untrusted);
  const result2 = await verifyProof(verifier, response2, { trustedIssuers: [sovereignId.did] });
  check('proof from an untrusted issuer is rejected', result2.ok === false);

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
