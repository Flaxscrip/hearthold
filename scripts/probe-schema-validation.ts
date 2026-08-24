/**
 * probe: does Archon enforce a schema's SHAPE — at issuance (bindCredential/issueCredential) and/or at
 * verification (verifyResponse) — or does it only match the schema DID? Settles whether schema-CONTROL has a
 * security dimension (a malicious Controller weakening the rules) or is purely governance.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/probe-schema-validation.ts
 */
import { loadConfig, openKeymaster, ensureIdentity } from '@hearthold/core';

const log = (m: string): void => process.stdout.write(`${m}\n`);

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'schema-probe';
  const issuer = await openKeymaster('warden', config, pass);
  const holder = await openKeymaster('sovereign', config, pass);
  const verifier = await openKeymaster('verifier', config, pass);
  const iId = await ensureIdentity(issuer, config);
  const hId = await ensureIdentity(holder, config);
  const vId = await ensureIdentity(verifier, config);

  const km = issuer.keymaster;
  await km.setCurrentId(iId.name);

  // A STRICT schema: name (string) + age (number), both required, no extra properties.
  const schema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } }, required: ['name', 'age'], additionalProperties: false };
  const schemaDid = await km.createSchema(schema, { registry: config.registry });
  log(`schema registered: ${schemaDid}`);
  log(`getSchema → ${JSON.stringify(await km.getSchema(schemaDid))}`);

  const cases: { label: string; claims: Record<string, unknown> }[] = [
    { label: 'valid {name,age}', claims: { name: 'Alice', age: 30 } },
    { label: 'missing required age', claims: { name: 'Alice' } },
    { label: 'wrong type age="thirty"', claims: { name: 'Alice', age: 'thirty' } },
    { label: 'extra field (additionalProperties)', claims: { name: 'Alice', age: 30, secret: 'x' } },
  ];

  for (const c of cases) {
    log(`\n── ${c.label} ──`);
    // 1) ISSUANCE — does bind/issue reject the violation?
    let credDid: string | undefined;
    try {
      await km.setCurrentId(iId.name);
      const bound = await km.bindCredential(hId.did, { schema: schemaDid, claims: c.claims });
      log(`  bind:   OK — credentialSubject=${JSON.stringify(bound.credentialSubject)}`);
      credDid = await km.issueCredential(bound, { schema: schemaDid });
      log(`  issue:  OK — ${credDid}`);
    } catch (e) {
      log(`  ISSUANCE REJECTED — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // 2) VERIFY — a credential that reached issuance: does verifyResponse validate its shape, or only match?
    try {
      await holder.keymaster.acceptCredential(credDid);
      await verifier.keymaster.setCurrentId(vId.name);
      const challenge = await verifier.keymaster.createChallenge({ credentials: [{ schema: schemaDid, issuers: [iId.did] }] }, { registry: config.registry });
      const response = await holder.keymaster.createResponse(challenge);
      const res = await verifier.keymaster.verifyResponse(response);
      const disclosed = (res.vps?.[0] as { credentialSubject?: unknown } | undefined)?.credentialSubject;
      log(`  verify: match=${res.match} fulfilled=${res.fulfilled}/${res.requested} — disclosed=${JSON.stringify(disclosed)}`);
      // Isolate cases: drop this credential so the next case's holder presents only ITS (violating) credential.
      await holder.keymaster.removeCredential(credDid).catch(() => undefined);
    } catch (e) {
      log(`  VERIFY threw — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log('\n(interpretation: if a VIOLATING credential both issues AND verifies match=true, the schema is a DID');
  log(' filter only — control = governance. If issuance or verify rejects it, the shape is enforced.)');
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
