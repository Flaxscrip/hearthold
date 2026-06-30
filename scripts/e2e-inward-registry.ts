/**
 * End-to-end test of the **inward registry wired into the Witness projector** — the standing-delegation
 * ceiling in action.
 *
 *   The Sovereign runs an inward registry of its Witnesses (TRQP over Archon groups) and clears this
 *   Witness to present at LOW (a `present`+`LOW` group), but not HIGH.
 *
 *   - LOW request  → Witness is cleared → it presents a credential it HOLDS, on its own, no Signet
 *                    (standing delegation). The presentation carries NO proof-of-human.
 *   - HIGH request → Witness is NOT cleared → it relays to the Sovereign; the Signet approves with
 *                    proof-of-human and presents. The presentation CARRIES a proof-of-human.
 *
 * Roles: guild = warden (issues the HIGH credential to the Sovereign); Sovereign = holder of the HIGH
 * credential + registry owner + issuer of the Witness's LOW credential; Witness = projector + holder of
 * the LOW credential; verifier = relying party.
 *
 * Run:  npm run e2e:inward-registry
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
  GroupTrustRegistry,
  createRegistryGroup,
  grantAuthorization,
  Sensitivity,
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

const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { type: { type: 'string' }, value: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
} as const;

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(`Hearthold inward-registry × projector e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision guild, Sovereign (holder + registry owner), Witness (projector), verifier');
  const guild: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const sovereign: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE);
  const witness: KeymasterHandle = await openKeymaster('witness', config, PASSPHRASE);
  const verifier: KeymasterHandle = await openKeymaster('verifier', config, PASSPHRASE);
  const guildId = await ensureIdentity(guild, config);
  const sovereignId = await ensureIdentity(sovereign, config);
  const witnessId = await ensureIdentity(witness, config);
  await ensureIdentity(verifier, config);
  check('identities ready', sovereignId.did.startsWith('did:') && witnessId.did.startsWith('did:'));

  step('Set up credentials: Witness holds a LOW cred (from Sovereign); Sovereign holds a HIGH cred (from guild)');
  const lowSchema = await sovereign.keymaster.createSchema(SCHEMA);
  const lowBound = await sovereign.keymaster.bindCredential(witnessId.did, {
    schema: lowSchema,
    claims: { type: 'PresencePass', value: 'lobby' },
  });
  const lowCred = await sovereign.keymaster.issueCredential(lowBound, { schema: lowSchema });
  await acceptCredential(witness, lowCred);

  const highSchema = await guild.keymaster.createSchema(SCHEMA);
  const highBound = await guild.keymaster.bindCredential(sovereignId.did, {
    schema: highSchema,
    claims: { type: 'ResidencyProof', value: 'FR-2026-H1' },
  });
  const highCred = await guild.keymaster.issueCredential(highBound, { schema: highSchema });
  await acceptCredential(sovereign, highCred);
  check('Witness holds LOW cred, Sovereign holds HIGH cred', lowCred.startsWith('did:') && highCred.startsWith('did:'));

  step('Sovereign\'s inward registry: clear the Witness to present at LOW (not HIGH)');
  const presentLowGroup = await createRegistryGroup(sovereign, 'hearthold-witness-present-LOW', config.registry);
  await grantAuthorization(sovereign, presentLowGroup, witnessId.did);
  const inwardRegistry = new GroupTrustRegistry(
    sovereign,
    [{ action: 'present', resource: 'LOW', group: presentLowGroup }],
    sovereignId.did,
  );
  // Local disclosure policy: this schema is HIGH, that one is LOW; anything unknown is SEALED (relay).
  const sensitivityFor = (schema?: string): Sensitivity =>
    schema === highSchema ? Sensitivity.HIGH : schema === lowSchema ? Sensitivity.LOW : Sensitivity.SEALED;

  step('Publish endpoints and start serving (Witness projector w/ autonomy; Sovereign w/ Signet)');
  const verifierTransport = new DidCommTransport(verifier, IDENTITY_NAME.verifier, config.nodeUrl);
  await verifierTransport.ready();
  const witT = new DidCommTransport(witness, IDENTITY_NAME.witness, config.nodeUrl);
  const sovT = new DidCommTransport(sovereign, IDENTITY_NAME.sovereign, config.nodeUrl);
  await witT.ready();
  await sovT.ready();

  const PIN = '1234';
  const stopSov = await sovT.serve(makeSovereignHandler(sovereign, new PinGate(PIN, PIN)), { pollMs: 1000 });
  const stopWit = await witT.serve(
    makeWitnessProjectorHandler(witT, sovereignId.did, {
      registry: inwardRegistry,
      witness,
      witnessDid: witnessId.did,
      sensitivityFor,
    }),
    { pollMs: 1000 },
  );

  const ask = async (schema: string, issuer: string): Promise<HearthholdMessage> => {
    const challengeDid = await requestProof(verifier, { schema, trustedIssuers: [issuer] });
    return verifierTransport.request(
      witnessId.did,
      { type: 'hearthold/proof-request', version: PROTOCOL_VERSION, challengeDid, schema },
      { pollMs: 1000 },
    );
  };

  try {
    step('LOW request → Witness cleared → presents on its own (no Signet, no proof-of-human)');
    {
      const reply = await ask(lowSchema, sovereignId.did);
      const pres = reply.type === 'hearthold/proof-presentation' ? (reply as ProofPresentationMessage) : null;
      check('got a proof-presentation', pres != null);
      check('NO proof-of-human (standing delegation)', pres?.humanProof === undefined);
      const result = await verifyProof(verifier, pres?.responseDid ?? '', { trustedIssuers: [sovereignId.did] });
      check('verifier verifies the LOW disclosure', result.ok === true);
    }

    step('HIGH request → Witness not cleared → relays to Signet → presented with proof-of-human');
    {
      const reply = await ask(highSchema, guildId.did);
      const pres = reply.type === 'hearthold/proof-presentation' ? (reply as ProofPresentationMessage) : null;
      check('got a proof-presentation', pres != null);
      check('CARRIES proof-of-human (Signet approved the relay)', pres?.humanProof?.method === 'pin');
      const result = await verifyProof(verifier, pres?.responseDid ?? '', { trustedIssuers: [guildId.did] });
      check('verifier verifies the HIGH disclosure', result.ok === true);
    }
  } finally {
    stopWit();
    stopSov();
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
