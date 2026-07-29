/**
 * e2e: READABLE HANDOVER — the two sender-initiated shapes on top of the provenance baseline (Sevenfold).
 *
 *   #2 forge-to-recipient: forge with `recipientDid` → the scroll is BOUND to the recipient (they can
 *      decrypt/read it), while the FORGER still co-signs the disclosure at their own Signet. A third party
 *      (non-subject) cannot read it. Absent recipientDid → bound to self (unchanged).
 *   #1 recipient-sealed rendering: the sender seals a rendering of the claims to `toDid`; the recipient
 *      Warden unseals it (sealed-to-us) → readable claims. The immutable ops stay the provenance anchor.
 *   + source-scan of the control-plane wiring for both.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-readable-handover.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  sealForWarden,
  unsealAsWarden,
  Sensitivity,
  PROTOCOL_VERSION,
  type EvidenceRequest,
  type ApprovalResponseMessage,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { EvidenceService, type SovereignApprover } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { PinGate } from '@hearthold/sovereign/signet';

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-readable-handover-e2e';
  const config = { ...base, dataRoot: `${base.dataRoot}-readable-handover` };

  const warden = await openKeymaster('warden', config, pass); // the forger/sender (issuer)
  const witness = await openKeymaster('emissary', config, pass); // a third party (non-subject)
  const sovereign = await openKeymaster('sovereign', config, pass); // the Signet (approves)
  const recipient = await openKeymaster('verifier', config, pass); // the RECIPIENT (forge-for target)
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  const sovId = await ensureIdentity(sovereign, config);
  const recipientId = await ensureIdentity(recipient, config);

  const delSchema = await ensureDelegationSchema(warden);
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const delCred = await issueDelegation(warden, witnessId.did, delSchema, { kinds: ['location'], validUntil: oneYear });
  await new DelegationStore(warden).record(witnessId.did, delCred);
  const store = new VaultStore(warden.dataFolder);
  for (const [i, day] of ['2026-02-04', '2026-03-11', '2026-04-20'].entries()) {
    await store.put({ id: hex(`ho-loc-${i}`), kind: 'location', observedAt: `${day}T09:00:00Z`, storedAt: new Date().toISOString(), sensitivity: Sensitivity.MEDIUM, ciphertext: hex(`ho-ct-${i}`), metadata: { witnessedBy: witnessId.did } });
  }
  const approver: SovereignApprover = (() => {
    const handler = makeSovereignHandler(sovereign, new PinGate('4242', '4242'));
    return { async requestApproval(req) { return (await handler(req, wardenId.did)) as ApprovalResponseMessage; } };
  })();
  const evidence = new EvidenceService(warden, { ...config, sovereignDid: sovId.did }, approver);
  const baseReq: EvidenceRequest = {
    type: 'hearthold/evidence-request',
    version: PROTOCOL_VERSION,
    claim: 'Resided in FR during 2026-H1',
    disclosureMode: 'ATTESTATION',
    spec: { kind: 'location', from: '2026-01-01', to: '2026-06-30', structured: { type: 'residence', country: 'FR' } },
    subjectDid: sovId.did, // the APPROVER (forger's Signet)
  };

  step('#2 forge-to-recipient — the scroll is BOUND to the recipient (readable by them), the forger approves');
  const forged = await evidence.handle({ ...baseReq, recipientDid: recipientId.did }, witnessId.did, true);
  check('the forge is GRANTED (forger co-signed)', forged.status === 'granted');
  if (forged.status !== 'granted') throw new Error('not granted');
  const asRecipient = await recipient.keymaster.getCredential(forged.credentialDid).catch(() => null);
  check('the RECIPIENT can decrypt/read the scroll (bound to them)', !!asRecipient && String(asRecipient.credentialSubject?.id) === recipientId.did);
  const asThirdParty = await witness.keymaster.getCredential(forged.credentialDid).catch(() => null);
  check('a third party (non-subject) canNOT read it', !asThirdParty || String(asThirdParty.credentialSubject?.id) !== recipientId.did);

  step('#2 control — forge-for-self (no recipientDid) still binds to the forger/self (unchanged)');
  const forgedSelf = await evidence.handle(baseReq, witnessId.did, true);
  check('self-forge granted + bound to the approver (sovereign)', forgedSelf.status === 'granted' && (await sovereign.keymaster.getCredential((forgedSelf as { credentialDid: string }).credentialDid).then((v) => String(v?.credentialSubject?.id) === sovId.did).catch(() => false)));

  step('#1 recipient-sealed rendering — the sender seals claims to the recipient Warden; the recipient unseals');
  const rendering = JSON.stringify({ claims: { residence: 'FR' }, credentialType: 'HearthholdAttestation', subject: sovId.did });
  const sealed = await sealForWarden(warden, recipientId.did, rendering); // sealed TO the recipient
  const opened = await unsealAsWarden(recipient, sealed).then((p) => JSON.parse(p) as { claims?: Record<string, unknown> }).catch(() => null);
  check('the recipient unseals the rendering → readable claims', opened?.claims?.residence === 'FR');
  const notForSender = await unsealAsWarden(warden, sealed).then(() => true).catch(() => false);
  check('the SENDER cannot unseal a blob addressed to the recipient', notForSender === false);

  step('source-scan — the control-plane wiring for both shapes');
  const control = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/warden/src/control.ts'), 'utf8');
  const evidenceSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/warden/src/evidence.ts'), 'utf8');
  check('evidence binds to recipientDid but keeps the forger as approver', /const bindSubject = req\.recipientDid \?\? subjectDid/.test(evidenceSrc) && /subjectDid: bindSubject/.test(evidenceSrc));
  check('forge route threads recipientDid', /recipientDid \? \{ recipientDid \}/.test(control));
  const passBlock = control.slice(control.indexOf("'POST /api/card/pass'"), control.indexOf("'POST /api/card/pass'") + 2600);
  check('card/pass seals a rendering to toDid on readable + ships recipientSealed', /if \(readable\)/.test(passBlock) && /sealForWarden\(handle, toDid/.test(passBlock) && /recipientSealed/.test(passBlock));
  check('card/pass co-sign summary names a READABLE disclosure', /READABLE card \(claims disclosed\)/.test(passBlock));
  check('the receipt handler unseals recipientSealed → contentReadable true', /unsealAsWarden\(handle, m\.recipientSealed\)/.test(control) && /contentReadable = true/.test(control));

  process.stdout.write(
    failures === 0
      ? '\n✓ readable-handover: forge-for-recipient binds readable-by-them (forger approves); recipient-sealed rendering round-trips; provenance stays the default\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-readable-handover: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
