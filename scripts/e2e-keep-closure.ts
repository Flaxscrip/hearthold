/**
 * e2e: THE KEEP CLOSURE — "keep this credential" is a SUBGRAPH, and the subgraph depends on the
 * verification GOAL, not the credential alone.
 *
 * A regulator (authority issuer) charters a bank (issuer); the bank issues a statement VC to a customer.
 * The bank then rotates its key. Two goals over the SAME statement VC:
 *   - `signed-by BANK`            → statement + schema + bank's ops TO THE SIGNING VERSION (not the rotation).
 *   - `signed-by-authorized`      → the above PLUS the bank's charter and the regulator's chain.
 * The two closures differ; the smaller one still verifies its weaker claim.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-keep-closure.ts
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  computeKeepClosure,
  type VerificationGoal,
  type ClosureSource,
  type KeymasterHandle,
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const STATEMENT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { type: { type: 'string' }, balance: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
} as const;
const CHARTER_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { type: { type: 'string' }, license: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
} as const;

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-closure-e2e';
  const cfg = (sub: string) => ({ ...base, dataRoot: join(base.dataRoot, sub) });

  step('Provision regulator (authority issuer), bank (issuer), customer (subject)');
  const regulator = await openKeymaster('registry', cfg('reg'), pass);
  const bank = await openKeymaster('warden', cfg('bank'), pass);
  const customer = await openKeymaster('sovereign', cfg('cust'), pass);
  const regId = await ensureIdentity(regulator, cfg('reg'));
  const bankId = await ensureIdentity(bank, cfg('bank'));
  const custId = await ensureIdentity(customer, cfg('cust'));

  step('Regulator charters the bank (the authority credential)');
  await regulator.keymaster.setCurrentId(IDENTITY_NAME.registry);
  const charterSchema = await regulator.keymaster.createSchema(CHARTER_SCHEMA);
  const charterBound = await regulator.keymaster.bindCredential(bankId.did, { schema: charterSchema, claims: { type: 'BankingCharter', license: 'LIC-2026-001' } });
  const charterDid = await regulator.keymaster.issueCredential(charterBound, { schema: charterSchema });

  step('Bank issues a statement VC to the customer (signed by the bank’s CURRENT key)');
  await bank.keymaster.setCurrentId(IDENTITY_NAME.warden);
  const stmtSchema = await bank.keymaster.createSchema(STATEMENT_SCHEMA);
  const stmtBound = await bank.keymaster.bindCredential(custId.did, { schema: stmtSchema, claims: { type: 'AccountStatement', balance: '£4,210.00' } });
  const stmtDid = await bank.keymaster.issueCredential(stmtBound, { schema: stmtSchema });

  step('Customer accepts the statement and reads its signing proof (issuer version, key)');
  await customer.keymaster.setCurrentId(IDENTITY_NAME.sovereign);
  await customer.keymaster.acceptCredential(stmtDid);
  const stmtVc = await customer.keymaster.getCredential(stmtDid);
  const signedAt = String(stmtVc?.proof?.created ?? '');
  const signingKey = String(stmtVc?.proof?.verificationMethod ?? '');
  check('statement carries a signing proof (created + verificationMethod)', signedAt.length > 0 && /#key-\d+$/.test(signingKey));

  step('Bank ROTATES its key AFTER signing — later versions must NOT enter the closure');
  await bank.keymaster.setCurrentId(IDENTITY_NAME.warden);
  await bank.keymaster.rotateKeys();
  const bankNow = await bank.gatekeeper.resolveDID(bankId.did);
  const bankLatestSeq = Number((bankNow.didDocumentMetadata as { versionSequence?: string | number })?.versionSequence);
  check('bank now has a later version than it did when it signed', Number.isFinite(bankLatestSeq) && bankLatestSeq >= 2);

  // The closure reads via the bank's gatekeeper client (resolveDID + exportDIDs — no import needed).
  const source = bank.gatekeeper as unknown as ClosureSource;
  const input = { credentialDid: stmtDid, schemaDid: stmtSchema, signedAt };

  step('GOAL A — "signed-by BANK": statement + schema + bank ops to the SIGNING version, nothing more');
  const goalA: VerificationGoal = { kind: 'signed-by', issuer: bankId.did };
  const closureA = await computeKeepClosure(input, goalA, source);
  const aDids = closureA.pins.map((p) => p.did);
  check('closure A has exactly 3 DIDs (statement, schema, issuer)', closureA.pins.length === 3);
  check('closure A does NOT reach the charter or the regulator', !aDids.includes(charterDid) && !aDids.includes(regId.did));
  const issuerPinA = closureA.pins.find((p) => p.role === 'issuer');
  check('the issuer is pinned to its SIGNING version, not latest (rotation excluded)', (issuerPinA?.versionSequence ?? 99) < bankLatestSeq);
  check('every pin is version-pinned (versionSequence AND content-addressed versionId)', closureA.pins.every((p) => Number.isFinite(p.versionSequence) && typeof p.versionId === 'string' && p.versionId.length > 0));

  step('GOAL B — "signed-by-authorized": the same PLUS the charter and the regulator chain');
  const goalB: VerificationGoal = { kind: 'signed-by-authorized', issuer: bankId.did, authority: { credentialDid: charterDid, authorityIssuer: regId.did } };
  const closureB = await computeKeepClosure(input, goalB, source);
  const bDids = closureB.pins.map((p) => p.did);
  check('closure B reaches 2 more DIDs than A (charter + regulator)', closureB.pins.length === closureA.pins.length + 2);
  check('closure B includes the charter credential and the regulator', bDids.includes(charterDid) && bDids.includes(regId.did));
  check('B keeps strictly more operations than A (the goal changed the subgraph)', closureB.totalOps > closureA.totalOps);

  step('The SMALLER closure still verifies its WEAKER claim ("signed by the bank")');
  // Sufficiency, from the ops alone: the bank's document at the pinned signing version carries the very key
  // that signed the statement — so closure A holds everything needed to verify "signed by the bank".
  const bankAtSigning = await bank.gatekeeper.resolveDID(bankId.did, { versionTime: signedAt });
  const methods = ((bankAtSigning.didDocument as { verificationMethod?: { id?: string }[] })?.verificationMethod ?? []).map((m) => m.id);
  check('the pinned signing version contains the key that signed the statement', methods.some((id) => id === signingKey || (id ?? '').endsWith(signingKey.split('#')[1] ?? '')));
  // And the weaker claim verifies live.
  check('statement proof verifies (weaker claim holds)', (await customer.keymaster.verifyProof(stmtVc!).catch(() => false)) === true);

  process.stdout.write(
    failures === 0
      ? '\n✓ keep-closure: goal-dependent, version-pinned minimal subgraphs; the weaker closure still proves its weaker claim\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-keep-closure: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
