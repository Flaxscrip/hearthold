/**
 * End-to-end test of the **trust registry** — TRQP authorization over Archon groups, both directions.
 *
 *   OUTWARD: a verifier trusts a *registry* instead of a hardcoded issuer. The registry owner puts the
 *   guild in the "issuers of GuildMembership" group; `verifyProof` consults the registry (no
 *   trustedIssuers list) → before the grant the proof is rejected, after it verifies.
 *
 *   INWARD: the same primitive grades a Emissary's autonomy. "Is this Emissary cleared to present at
 *   HIGH?" = membership in the `present+HIGH` group. Granting lets it act alone; revoking (condition
 *   dropped) downgrades it back to relay-to-Signet.
 *
 * Stand-in roles: guild = warden id, holder = sovereign, verifier = verifier id, registry owner +
 * the Emissary being assured = witness id.
 *
 * Run:  npm run e2e:trust-registry
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
  GroupTrustRegistry,
  createRegistryGroup,
  grantAuthorization,
  revokeAuthorization,
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
  process.stdout.write(`Hearthold trust-registry e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision guild (issuer), holder, verifier, registry owner / Emissary');
  const guild: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const holder: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE);
  const verifier: KeymasterHandle = await openKeymaster('verifier', config, PASSPHRASE);
  const registry: KeymasterHandle = await openKeymaster('emissary', config, PASSPHRASE);
  const guildId = await ensureIdentity(guild, config);
  const holderId = await ensureIdentity(holder, config);
  await ensureIdentity(verifier, config);
  const registryId = await ensureIdentity(registry, config);
  check('identities ready', guildId.did.startsWith('did:') && registryId.did.startsWith('did:'));

  step('Guild issues a GuildMembership credential to the holder');
  const schemaDid = await guild.keymaster.createSchema(GUILD_SCHEMA);
  const bound = await guild.keymaster.bindCredential(holderId.did, {
    schema: schemaDid,
    claims: { type: 'GuildMembership', guild: 'Example Guild', role: 'Raid-Lead' },
  });
  const credDid = await guild.keymaster.issueCredential(bound, { schema: schemaDid });
  await acceptCredential(holder, credDid);
  check('holder holds the credential', credDid.startsWith('did:'));

  // ── OUTWARD: the verifier trusts the registry, not a hardcoded issuer ──────────
  step('Registry owner creates the "issuers of GuildMembership" group');
  const issuersGroup = await createRegistryGroup(registry, 'hearthold-issuers-GuildMembership', config.registry);
  // The registry runs as its owner: it answers authorization by group membership.
  const trustRegistry = new GroupTrustRegistry(
    registry,
    [{ action: 'issue', resource: schemaDid, group: issuersGroup }],
    registryId.did,
  );
  check('issuers group created', issuersGroup.startsWith('did:'));

  const proveViaRegistry = async () => {
    // No trustedIssuers: the challenge is schema-only (any issuer); the registry decides trust.
    const challengeDid = await requestProof(verifier, { schema: schemaDid });
    const responseDid = await presentProof(holder, challengeDid);
    return verifyProof(verifier, responseDid, { trustRegistry, schema: schemaDid, requiredClaims: { role: 'Raid-Lead' } });
  };

  step('Before grant: registry does not authorize the guild → proof rejected');
  {
    const result = await proveViaRegistry();
    check('rejected (issuer not in registry)', result.ok === false);
  }

  step('Registry owner authorizes the guild to issue GuildMembership');
  await grantAuthorization(registry, issuersGroup, guildId.did);

  step('After grant: registry authorizes the guild → proof verifies');
  {
    const result = await proveViaRegistry();
    check('verified via registry (no hardcoded trustedIssuers)', result.ok === true);
    check('disclosed role = Raid-Lead', result.disclosed[0]?.claims.role === 'Raid-Lead');
  }

  // ── INWARD: the same registry grades a Emissary's autonomy ─────────────────────
  step('Inward: grade a Emissary\'s autonomy to present at HIGH');
  const presentHighGroup = await createRegistryGroup(registry, 'hearthold-witness-present-HIGH', config.registry);
  const assurance = new GroupTrustRegistry(
    registry,
    [{ action: 'present', resource: 'HIGH', group: presentHighGroup }],
    registryId.did,
  );
  const emissaryDid = registryId.did; // the Emissary being assured

  {
    const r = await assurance.authorize({ entity_id: emissaryDid, action: 'present', resource: 'HIGH' });
    check('Emissary NOT yet cleared for HIGH → would relay to Signet', r.authorized === false);
  }

  step('Condition met: grant the Emissary HIGH-present clearance');
  await grantAuthorization(registry, presentHighGroup, emissaryDid);
  {
    const r = await assurance.authorize({ entity_id: emissaryDid, action: 'present', resource: 'HIGH' });
    check('Emissary now cleared for HIGH → may act alone', r.authorized === true);
  }

  step('Condition drops: revoke clearance → auto-downgrade');
  await revokeAuthorization(registry, presentHighGroup, emissaryDid);
  {
    const r = await assurance.authorize({ entity_id: emissaryDid, action: 'present', resource: 'HIGH' });
    check('Emissary downgraded → back to relay-to-Signet', r.authorized === false);
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
