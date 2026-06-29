/**
 * Prototype: DTG **Witness Credential (VWC)** issuance on Archon.
 *
 * Exercises the witnessed-VRC pair on real keymaster + the live node:
 *   1. The Sovereign (observed party) issues a **VRC** (RelationshipCredential) to a counterparty.
 *   2. The **Witness** (W-DID) issues a **VWC** (WitnessCredential) about the Sovereign, digesting the
 *      witnessed VRC and recording `witnessContext { event, sessionId, method }`.
 *   3. We read the VWC back from the node and check what Archon actually persisted — the DTG type
 *      hierarchy, the DTG @context, and the nested `witnessContext` (answers docs §8 Q#1/Q#2).
 *   4. The Sovereign accepts the VWC and presents it through the prove flow; a verifier that trusts
 *      the W-DID verifies it — proving a DTG VWC is a first-class, presentable Archon credential.
 *
 * Stand-in roles: witness = witness id (W-DID), observed = sovereign id, counterparty = warden id,
 * relying party = verifier id.
 *
 * Run:  npm run proto:vwc
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureSchema,
  dtgSchema,
  DtgType,
  DTG_CONTEXT,
  issueVrc,
  issueVwc,
  credentialDigest,
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

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(`DTG VWC issuance prototype\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision witness (W-DID), observed Sovereign, counterparty, verifier');
  const witness: KeymasterHandle = await openKeymaster('witness', config, PASSPHRASE);
  const sovereign: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE);
  const counterparty: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const verifier: KeymasterHandle = await openKeymaster('verifier', config, PASSPHRASE);
  const witnessId = await ensureIdentity(witness, config);
  const sovereignId = await ensureIdentity(sovereign, config);
  const counterpartyId = await ensureIdentity(counterparty, config);
  await ensureIdentity(verifier, config);
  check('identities ready', witnessId.did.startsWith('did:') && sovereignId.did.startsWith('did:'));

  const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();

  step('Sovereign issues a VRC (relationship edge) to the counterparty');
  const vrcSchema = await ensureSchema(sovereign, 'dtg/VRC', dtgSchema(DtgType.RELATIONSHIP));
  const vrcDid = await issueVrc(sovereign, counterpartyId.did, vrcSchema, validUntil);
  const vrc = await sovereign.keymaster.getCredential(vrcDid);
  check('VRC issued', vrcDid.startsWith('did:') && vrc != null);
  check('VRC type carries DTGCredential + RelationshipCredential',
    !!vrc && vrc.type.includes(DtgType.BASE) && vrc.type.includes(DtgType.RELATIONSHIP));
  process.stdout.write(`  VRC type: ${JSON.stringify(vrc?.type)}\n`);

  step('Witness issues a VWC about the Sovereign, digesting the witnessed VRC');
  const vwcSchema = await ensureSchema(witness, 'dtg/VWC', dtgSchema(DtgType.WITNESS));
  const witnessContext = {
    event: 'Drake Island raid form-up',
    sessionId: 'session-drake-7731',
    method: 'virtual-realtime',
  };
  const vwcDid = await issueVwc(witness, sovereignId.did, vwcSchema, {
    witnessedVrc: vrc,
    witnessContext,
    validUntil,
  });
  const vwc = await witness.keymaster.getCredential(vwcDid);
  if (!vwc) throw new Error('VWC not resolvable after issue');

  step('What Archon persisted for the VWC');
  process.stdout.write(`${JSON.stringify(vwc, null, 2)}\n`);

  step('Checks — does the node round-trip the DTG shape?');
  const subject = (vwc.credentialSubject ?? {}) as Record<string, unknown>;
  const wctx = (subject.witnessContext ?? {}) as Record<string, unknown>;
  check('VC 2.0 shape (validFrom present)', typeof vwc.validFrom === 'string' && vwc.validFrom.length > 0);
  check('type array kept DTGCredential', vwc.type.includes(DtgType.BASE));
  check('type array kept WitnessCredential', vwc.type.includes(DtgType.WITNESS));
  check('@context kept the DTG context', (vwc['@context'] ?? []).includes(DTG_CONTEXT));
  check('issuer == Witness W-DID', vwc.issuer === witnessId.did);
  check('subject.id == observed Sovereign', subject.id === sovereignId.did);
  check('nested witnessContext.sessionId round-tripped', wctx.sessionId === witnessContext.sessionId);
  check('nested witnessContext.method round-tripped', wctx.method === witnessContext.method);
  check('digest matches the witnessed VRC', subject.digest === credentialDigest(vrc));

  step('VWC is presentable + verifiable through the prove flow');
  await acceptCredential(sovereign, vwcDid);
  const challengeDid = await requestProof(verifier, { schema: vwcSchema, trustedIssuers: [witnessId.did] });
  const responseDid = await presentProof(sovereign, challengeDid);
  const result = await verifyProof(verifier, responseDid, { trustedIssuers: [witnessId.did] });
  check('verifier verifies the VWC (issuer = trusted W-DID)', result.ok === true);
  check('disclosed VWC carries the witnessContext',
    !!(result.disclosed[0]?.claims.witnessContext as { sessionId?: string })?.sessionId);
  process.stdout.write(`  disclosed claims: ${JSON.stringify(result.disclosed[0]?.claims ?? {})}\n`);

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\nproto error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
