/**
 * e2e: subject-keyed R-DID — DID-aware bank onboarding (financial theme).
 *
 * A Sovereign presents a pairwise R-DID to a DID-aware institution (a bank), which challenges it to
 * PROVE CONTROL before binding + issuing a credential. This is the SUBJECT-KEYED path: the R-DID is
 * minted in the Sovereign's OWN (Signet) wallet, so the Sovereign proves control DIRECTLY with their own
 * key — the Warden (custodian) holds no key for it and cannot answer for it. The bank then issues an
 * AccreditedInvestor credential to the R-DID; the Sovereign accepts it on a DID it controls.
 *
 * Contrast with the disclosure-pairwise path (Warden-minted, Warden presents on the Sovereign's behalf):
 * that is right for showing evidence to a verifier, but wrong for an identity anchor a bank KYCs.
 *
 * Isolated data root; run:  npm run e2e:finance-onboarding
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  resolvePairwiseDid,
  proveControl,
  MemoryPairwiseStore,
  ensureSchema,
  openSchema,
  issueClaim,
  acceptCredential,
} from '@hearthold/core';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-finance-onboarding';
  const reg = config.registry;

  const sovereign = await openKeymaster('sovereign', config, pass); // the principal (Signet wallet)
  const warden = await openKeymaster('warden', config, pass); // the custodian
  const bank = await openKeymaster('verifier', config, pass); // "Meridian Capital" — the institution
  const sovId = await ensureIdentity(sovereign, config);
  await ensureIdentity(warden, config);
  const bankId = await ensureIdentity(bank, config);
  const now = new Date().toISOString();

  process.stdout.write('\n▸ Sovereign mints a SUBJECT-KEYED R-DID for the bank (in the Signet wallet)\n');
  const sovStore = new MemoryPairwiseStore(); // the Sovereign's own pairwise linkages (its R-DIDs)
  const rec = await resolvePairwiseDid(sovereign, sovStore, {
    audience: bankId.did,
    subjectDid: sovId.did,
    createdAt: now,
    keyHolder: 'subject',
    registry: reg,
  });
  assert(rec.keyHolder === 'subject', 'the R-DID is recorded subject-keyed (the Sovereign holds the key)');
  assert(rec.pairwiseDid !== sovId.did, "the R-DID is pairwise — NOT the Sovereign's stable DID");
  const sovIds = (await sovereign.keymaster.listIds()) as string[];
  const wardenIds = (await warden.keymaster.listIds()) as string[];
  assert(sovIds.includes(rec.name), "the R-DID lives in the Sovereign's own wallet");
  assert(!wardenIds.includes(rec.name), "the Warden's wallet does NOT hold the R-DID key");

  process.stdout.write('\n▸ The bank challenges → the Sovereign proves control with its OWN key\n');
  const challenge = await bank.keymaster.createChallenge({}, { registry: reg });
  const response = await proveControl(sovereign, rec.name, challenge, { registry: reg });
  const verify = (await bank.keymaster.verifyResponse(response)) as { match?: boolean; responder?: string };
  assert(verify.match === true, 'the bank verifies the response — control is proven');
  assert(verify.responder === rec.pairwiseDid, 'the responder IS the R-DID (signed by its own key, no custodian)');

  process.stdout.write('\n▸ The Warden (custodian) CANNOT prove control — it holds no key for the R-DID\n');
  let wardenProved = false;
  try {
    const c2 = await bank.keymaster.createChallenge({}, { registry: reg });
    const r2 = await proveControl(warden, rec.name, c2, { registry: reg });
    const v2 = (await bank.keymaster.verifyResponse(r2)) as { match?: boolean; responder?: string };
    wardenProved = v2.match === true && v2.responder === rec.pairwiseDid;
  } catch {
    wardenProved = false;
  }
  assert(!wardenProved, 'the Warden cannot answer the challenge for the R-DID (never in the signing path)');

  process.stdout.write('\n▸ The bank binds + issues AccreditedInvestor → the R-DID; the Sovereign accepts on a DID it controls\n');
  const schemaDid = await ensureSchema(bank, 'AccreditedInvestor', openSchema('AccreditedInvestor'));
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const credDid = await issueClaim(
    bank,
    rec.pairwiseDid,
    schemaDid,
    { type: 'AccreditedInvestor', authority: 'Meridian Capital', tier: 'accredited' },
    oneYear,
  );
  // Accept AS the R-DID — its key decrypts the VC that was encrypted to it.
  const prev = await sovereign.keymaster.getCurrentId().catch(() => undefined);
  await sovereign.keymaster.setCurrentId(rec.name);
  const accepted = await acceptCredential(sovereign, credDid);
  if (prev) await sovereign.keymaster.setCurrentId(prev);
  assert(accepted, 'the Sovereign accepts the VC — it was encrypted to a DID the Sovereign controls');

  process.stdout.write(
    '\n✓ Subject-keyed R-DID: the Sovereign proves control directly (own key), the bank binds + issues to it,\n' +
      '  and the Warden holds no key — the right trust shape for a KYC identity anchor.\n',
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-finance-onboarding: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
