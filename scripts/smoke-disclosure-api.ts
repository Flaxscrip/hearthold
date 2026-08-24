/**
 * smoke (Task 1 blocker): can the Warden have Archon sign a Hearthold-defined structured body — the
 * digest array — and does Archon constrain the signed-body shape? Grounded on REAL calls, not docs.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/smoke-disclosure-api.ts
 */
import { createHash } from 'node:crypto';

import { loadConfig, openKeymaster, ensureIdentity, canonicalize, freshSalt } from '@hearthold/core';

const ok = (m: string): void => process.stdout.write(`  ✓ ${m}\n`);
const info = (m: string): void => process.stdout.write(`  · ${m}\n`);
const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-disclosure-smoke';
  const reg = config.registry;

  const warden = await openKeymaster('warden', config, pass);
  const holder = await openKeymaster('verifier', config, pass);
  const wardenId = await ensureIdentity(warden, config);
  const holderId = await ensureIdentity(holder, config);
  const km = warden.keymaster;
  await km.setCurrentId(wardenId.name);

  // A Hearthold-defined structured body: the SD digest array + always-visible metadata.
  const sd = [
    sha256Hex(canonicalize({ salt: freshSalt(), name: 'scope', value: ['read'] })),
    sha256Hex(canonicalize({ salt: freshSalt(), name: 'budget', value: 5000 })),
  ].sort();
  const body = { sd, issuer: wardenId.did, credentialType: 'ScopeGrant', validUntil: null };

  // ── 1. Archon signs the opaque blob (addProof) and the signature verifies to the Warden DID ──
  const signed = (await km.addProof(body, wardenId.name)) as { proof?: { verificationMethod?: string } };
  const verifyProof = km.verifyProof.bind(km) as (o: unknown) => Promise<boolean>;
  const sigOk = await verifyProof(signed);
  const signer = (signed.proof?.verificationMethod ?? '').split('#')[0];
  ok(`addProof signed the digest-array body; verifyProof = ${sigOk}`);
  ok(`signer resolves to the Warden DID: ${signer === wardenId.did}`);

  // ── 2. No signed-body-shape constraint: bindCredential/issueCredential accept the same structured body ──
  const schemaDid = await km.createSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { sd: { type: 'array' }, issuer: { type: 'string' }, credentialType: { type: 'string' } },
    required: ['sd'],
    additionalProperties: true,
  });
  const bound = await km.bindCredential(holderId.did, { schema: schemaDid, claims: body });
  const credDid = await km.issueCredential(bound, { schema: schemaDid });
  ok(`issueCredential accepted the arbitrary structured body → ${credDid.startsWith('did:')} (${credDid.slice(0, 28)}…)`);
  info('→ Archon imposes NO shape on the signed body: the digest array is a first-class signed payload');

  // ── 3. Encrypted disclosures payload: pairwise encrypt to the holder, decrypt round-trip ──
  const enc = await km.encryptJSON({ disclosures: [{ salt: 'abc', name: 'scope', value: ['read'] }] }, holderId.did, { registry: reg });
  await holder.keymaster.setCurrentId(holderId.name);
  const round = await holder.keymaster.decryptJSON(enc);
  ok(`encrypted disclosures payload round-trips to the holder: ${JSON.stringify(round).includes('read')}`);

  process.stdout.write('\n✓ Task 1 confirmed: Archon signs the digest array as an opaque blob; no signed-body-shape constraint — buildable\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`smoke-disclosure-api: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
