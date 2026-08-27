/**
 * roleplay: HEALTHCARE ED-ADMISSION — the VERIFIER side, live against Archon.
 *
 * An incapacitated patient is admitted to an Emergency Department. The hospital must verify a FEW
 * specific facts — coverage active, drug allergies, code status — WITHOUT the patient handing over
 * their whole record. Every party is a local Keymaster identity so this runs today; the external
 * health-plan issuer ("The Architect", Kent Hargesheimer's AI assistant) is played by a local stand-in
 * that the Architect's REAL DID + credential slot into via env vars (see ENV SLOTS below).
 *
 * Roles → wallets (each its own did:cid, independently custodied):
 *   patient           = sovereign   (the principal; mints the admission capability)
 *   caregiver         = emissary     (distinct party; holds the delegated, narrowed capability)
 *   Warden (custodian)= warden       (authors consent, derives + signs the clinical summary — issuer-attested)
 *   hospital ED       = verifier     (the party that TRUSTS SIGNATURES, not the custodian's word)
 *   health-plan issuer= registry     (stand-in for The Architect; issues coverage + owns the status list)
 *
 * The custodian (Warden) and the verifier (ED) are DELIBERATELY two DIDs — that separation is the point:
 * the ED trusts the issuer's signature, never the Warden's assertion.
 *
 * ── ENV SLOTS (the Architect's real artifacts substitute here) ─────────────────────────────────────────
 *   HEALTHPLAN_ISSUER_DID          the Architect's issuer DID (trusted-issuer set for the coverage proof)
 *   HEALTHPLAN_COVERAGE_CRED_DID   a coverage credential the Architect issued to the patient (sovereign) DID
 * When BOTH are set, leg 3 verifies the ARCHITECT'S REAL credential (schema auto-discovered from the VC).
 * When unset, a local stub coverage credential is issued + verified so the script runs today. Each leg
 * prints which mode it used. The status-list break-it cases (a)/(e) always run on a LOCAL revocable
 * coverage credential we own, because we cannot revoke a credential in the Architect's status list.
 *
 * ── WHAT IS ASSERTED (every check can fail; a failing check exits non-zero and never prints PASS) ───────
 *   1  patient mints a ROOT admission cap and delegates a NARROWED, single-use child to the caregiver
 *   2  the WARDEN authors the consent text the caregiver approves (not the requester)
 *   3  the coverage credential verifies issuer-attested: signature → issuer DID, trusted, coverageActive
 *   4  selective disclosure of the clinical summary reveals EXACTLY the two requested fields, nothing else
 *   (a) REVOKED coverage is caught (status bit set → StatusListResolver → verify refuses)
 *   (b) a WIDENED delegation THROWS at issuance (widening is unrepresentable)
 *   (c) a REQUESTER-authored consent string is ignored; the Warden's authored text is what's used
 *   (d) KEY ROTATION: a pre-rotation coverage credential STILL verifies (version-pinned resolution)
 *   (e) OFFLINE revocation FAILS CLOSED (unresolvable status list → available:false → verify fails)
 *
 * Run (confirm node up: curl -s http://flaxlap.local:4222/didcomm/health → {"ready":true}):
 *   HEARTHOLD_PASSPHRASE='roleplay-health' HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 \
 *   HEARTHOLD_REGISTRY=local HEARTHOLD_DATA_ROOT=.hearthold-roleplay-health \
 *   npm run roleplay:admit-health
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  mintRootCapability,
  delegateCapability,
  verifyCapabilityChain,
  discloseChain,
  createStatusList,
  revokeStatusIndex,
  StatusListResolver,
  issueDisclosureCredential,
  assemblePresentation,
  verifyPresentation,
  requestProof,
  presentProof,
  verifyProof,
  acceptCredential,
  getCredential,
  decideRelease,
  Sensitivity,
  AuthzTier,
  DisclosureMode,
  type KeymasterHandle,
  type Caveats,
} from '@hearthold/core';

const line = (m: string): void => process.stdout.write(`${m}\n`);
const step = (m: string): void => process.stdout.write(`\n════ ${m} ════\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── The Warden authors ALL consent text ────────────────────────────────────────────────────────────────
// A requester's own words are INPUT EVIDENCE, never the screen the human sees. This is the structural cure
// for requester-authored-consent manipulation when the requester is an AI (docs/security-model.md).
function wardenAuthorConsent(fields: string[]): string {
  return `Disclose to the ED: ${fields.join(', ')}.`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE ?? 'roleplay-health';
  const reg = config.registry;
  line(`Hearthold roleplay — ED admission (verifier side)\n  node: ${config.nodeUrl}\n  registry: ${reg}\n  data: ${config.dataRoot}`);

  step('Provision the five parties');
  const patient = await openKeymaster('sovereign', config, pass);
  const caregiver = await openKeymaster('emissary', config, pass);
  const warden = await openKeymaster('warden', config, pass);       // custodian: authors consent + issues clinical summary
  const ed = await openKeymaster('verifier', config, pass);          // hospital ED: trusts signatures
  const healthplan = await openKeymaster('registry', config, pass);  // stand-in for The Architect
  const patientId = await ensureIdentity(patient, config);
  const caregiverId = await ensureIdentity(caregiver, config);
  const wardenId = await ensureIdentity(warden, config);
  const edId = await ensureIdentity(ed, config);
  const healthplanId = await ensureIdentity(healthplan, config);
  check('five distinct identities ready', new Set([patientId.did, caregiverId.did, wardenId.did, edId.did, healthplanId.did]).size === 5);
  line(`  patient=${patientId.did.slice(0, 20)}… caregiver=${caregiverId.did.slice(0, 20)}… ed=${edId.did.slice(0, 20)}… healthplan=${healthplanId.did.slice(0, 20)}…`);

  // ── LEG 1: mint ROOT admission cap → delegate a NARROWED, single-use child to the caregiver ────────────
  step('LEG 1 — patient mints a ROOT admission capability, delegates a NARROWED child to the caregiver');
  const ADMISSION = 'admission';
  const root = await mintRootCapability({
    issuer: patient,
    issuerName: patientId.name,
    holder: patientId.did,
    capability: {
      invocationTarget: ADMISSION,
      authority: { operations: ['prove'], resources: [ADMISSION] },
      caveats: { ceiling: Sensitivity.SEALED, owner: patientId.did },
    },
    registry: reg,
  });
  check('ROOT admission capability minted (counter 0)', root.issued.counter === 0, root.issued.vcDid.slice(0, 28) + '…');

  // Child NARROWS: same op/resource, ceiling SEALED→MEDIUM, and ADDS a single-use caveat (adding a
  // restriction is monotonic narrowing — permitted; widening is not, see case (b)).
  const caregiverCaveats: Caveats = { ceiling: Sensitivity.MEDIUM, owner: patientId.did, singleUse: true };
  const caregiverCap = await delegateCapability({
    issuer: patient,
    issuerName: patientId.name,
    parent: root,
    holder: caregiverId.did,
    child: { invocationTarget: ADMISSION, authority: { operations: ['prove'], resources: [ADMISSION] }, caveats: caregiverCaveats },
    registry: reg,
  });
  check('caregiver delegation minted (counter 1, single-use, ceiling MEDIUM)', caregiverCap.issued.counter === 1 && caregiverCap.capability.caveats.singleUse === true);

  const chain = await verifyCapabilityChain(caregiverCap.issued.vcDid, {
    keymaster: ed as KeymasterHandle,
    expectedRootIssuer: patientId.did,
    disclosed: discloseChain(caregiverCap, root),
    orderedCaveats: [caregiverCap.capability.caveats, root.capability.caveats],
  });
  check('caregiver holds a VALID subset-chained capability (authority ⊆ + caveats narrow + signatures + lineage)', chain.ok, chain.reason ?? '');

  // Tie the capability's MEDIUM ceiling to the deny-by-default release ladder (security.ts). The caregiver's
  // cap clears MEDIUM, so a MEDIUM disclosure is allowed but a HIGH one is DENIED at the same tier.
  const clearsMedium = decideRelease({ sensitivity: Sensitivity.MEDIUM, tier: AuthzTier.CHALLENGE, delegationValid: chain.ok, mode: DisclosureMode.SELECTIVE, disclosureSatisfiable: true });
  const clearsHigh = decideRelease({ sensitivity: Sensitivity.HIGH, tier: AuthzTier.CHALLENGE, delegationValid: chain.ok, mode: DisclosureMode.SELECTIVE, disclosureSatisfiable: true });
  check('release ladder: MEDIUM disclosure ALLOWED at the caregiver-cleared tier', clearsMedium.allow, clearsMedium.reason);
  check('release ladder: HIGH disclosure DENIED at the same tier (deny-by-default step-up)', !clearsHigh.allow, clearsHigh.reason);

  // ── LEG 2: the WARDEN authors the consent the caregiver approves ───────────────────────────────────────
  step('LEG 2 — the WARDEN authors the consent text the caregiver approves');
  const consentFields = ['coverage-active', 'drug-allergies', 'code-status'];
  const wardenConsent = wardenAuthorConsent(consentFields);
  const consentPresentedToSignet = wardenConsent; // what the caregiver's Signet actually shows
  line(`  Warden-authored consent: "${wardenConsent}"`);
  check('the consent the caregiver approves IS the Warden-authored string', consentPresentedToSignet === wardenConsent);

  // ── LEG 3: verify the health-plan COVERAGE credential (issuer-attested) ────────────────────────────────
  step('LEG 3 — verify the health-plan COVERAGE credential (issuer-attested; trust the signature, not the hospital)');
  const envIssuer = process.env.HEALTHPLAN_ISSUER_DID?.trim();
  const envCoverageCred = process.env.HEALTHPLAN_COVERAGE_CRED_DID?.trim();
  const realMode = Boolean(envIssuer && envCoverageCred);

  // Coverage schema (local). In real mode we DISCOVER the Architect's schema from the credential itself.
  const COVERAGE_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { type: { type: 'string' }, coverageActive: { type: 'boolean' }, plan: { type: 'string' } },
    required: ['type', 'coverageActive'],
    additionalProperties: true,
  } as const;

  let coverageIssuerDid: string;
  let coverageSchemaDid: string;
  let coverageCredDid: string;

  if (realMode) {
    line(`  MODE: REAL — verifying The Architect's issued credential`);
    line(`    issuer      = ${envIssuer}`);
    line(`    coverage VC = ${envCoverageCred}`);
    coverageIssuerDid = envIssuer!;
    coverageCredDid = envCoverageCred!;
    // The patient accepts the Architect's credential, then we discover the schema it was bound to.
    await acceptCredential(patient, coverageCredDid);
    const vc = await getCredential(patient, coverageCredDid);
    const discoveredSchema = vc?.credentialSchema?.id ?? process.env.HEALTHPLAN_COVERAGE_SCHEMA_DID?.trim();
    if (!discoveredSchema) throw new Error('real coverage credential carries no credentialSchema.id — set HEALTHPLAN_COVERAGE_SCHEMA_DID to the schema the Architect issued on');
    coverageSchemaDid = discoveredSchema;
    check('accepted the Architect coverage credential + discovered its schema', vc != null && coverageSchemaDid.startsWith('did:'), coverageSchemaDid.slice(0, 28) + '…');
  } else {
    line(`  MODE: STUB — health-plan stand-in (registry wallet) issues a local coverage credential`);
    line(`    (set HEALTHPLAN_ISSUER_DID + HEALTHPLAN_COVERAGE_CRED_DID to verify the Architect's real one)`);
    coverageIssuerDid = healthplanId.did;
    coverageSchemaDid = await healthplan.keymaster.createSchema(COVERAGE_SCHEMA);
    const bound = await healthplan.keymaster.bindCredential(patientId.did, {
      schema: coverageSchemaDid,
      claims: { type: 'CoverageStatus', coverageActive: true, plan: 'Acme Health PPO' },
    });
    coverageCredDid = await healthplan.keymaster.issueCredential(bound, { schema: coverageSchemaDid });
    await acceptCredential(patient, coverageCredDid);
    check('stub coverage credential issued + accepted by the patient', coverageCredDid.startsWith('did:'));
  }

  // Issuer-attested verification via the canonical prove flow (Archon verifyResponse resolves the
  // credential-matching key — the same path that makes case (d) rotation-safe).
  const verifyCoverageProof = async (opts: { trustedIssuer: string }) => {
    const challenge = await requestProof(ed, { schema: coverageSchemaDid, trustedIssuers: [opts.trustedIssuer] });
    const response = await presentProof(patient, challenge);
    return verifyProof(ed, response, { trustedIssuers: [opts.trustedIssuer], requiredClaims: { coverageActive: true } });
  };
  const coverageResult = await verifyCoverageProof({ trustedIssuer: coverageIssuerDid });
  check('coverage proof VERIFIES (issuer signature resolves to the issuer DID)', coverageResult.ok, coverageResult.reason ?? '');
  check('disclosed issuer = the trusted health-plan issuer', coverageResult.disclosed[0]?.issuer === coverageIssuerDid);
  check('coverageActive === true (issuer-attested)', coverageResult.disclosed[0]?.claims.coverageActive === true);

  // Negative: an ED that does NOT trust this issuer gets nothing — trust rests on the signature.
  const untrusted = await verifyCoverageProof({ trustedIssuer: patientId.did }); // patient issued no coverage
  check('an ED that trusts the WRONG issuer is refused (issuer-attested, not hospital-attested)', !untrusted.ok, untrusted.reason ?? '');

  // ── LEG 4: SELECTIVE DISCLOSURE of the clinical summary — reveal ONLY two fields ───────────────────────
  step('LEG 4 — selective disclosure of the clinical summary (reveal EXACTLY two fields, nothing else)');
  // The Warden (custodian) derives + signs the clinical summary; the ED holds the encrypted payload.
  const summary = await issueDisclosureCredential({
    issuer: warden,
    issuerName: wardenId.name,
    holder: edId.did,
    credentialType: 'ClinicalSummary',
    properties: {
      drugAllergies: ['penicillin', 'sulfa'],
      codeStatus: 'DNR',
      activeMedications: ['metoprolol', 'atorvastatin'],
      conditions: ['atrial fibrillation', 'type 2 diabetes'],
    },
    registry: reg,
  });
  const requested = ['drugAllergies', 'codeStatus'];
  const presentation = assemblePresentation(summary.commitments, summary.disclosures, requested);
  const pres = await verifyPresentation(presentation, { keymaster: ed as KeymasterHandle, expectedIssuer: wardenId.did });
  check('clinical-summary presentation VERIFIES (issuer signature over the digest array)', pres.ok, pres.reason ?? '');
  const disclosedNames = Object.keys(pres.disclosed ?? {}).sort();
  check('disclosed contains EXACTLY [codeStatus, drugAllergies]', JSON.stringify(disclosedNames) === JSON.stringify(['codeStatus', 'drugAllergies']), disclosedNames.join(','));
  check('drug allergies disclosed correctly', JSON.stringify(pres.disclosed?.drugAllergies) === JSON.stringify(['penicillin', 'sulfa']));
  check('code status disclosed correctly', pres.disclosed?.codeStatus === 'DNR');
  check('activeMedications was NOT disclosed', !('activeMedications' in (pres.disclosed ?? {})));
  check('conditions was NOT disclosed', !('conditions' in (pres.disclosed ?? {})));

  // ── STATUS LIST for revocable coverage — always LOCAL (we cannot revoke the Architect's list) ──────────
  step('Set up a revocable LOCAL coverage credential (health-plan owns the status list) for cases (a)/(e)');
  const COVERAGE_IDX = 777;
  const { statusListCredential } = await createStatusList(healthplan, healthplanId.name, config);
  const revSchema = realMode ? await healthplan.keymaster.createSchema(COVERAGE_SCHEMA) : coverageSchemaDid;
  const revBound = await healthplan.keymaster.bindCredential(caregiverId.did, {
    schema: revSchema,
    claims: { type: 'CoverageStatus', coverageActive: true, plan: 'Acme Health PPO', statusListIndex: COVERAGE_IDX },
  });
  const revCoverageCred = await healthplan.keymaster.issueCredential(revBound, { schema: revSchema });
  await acceptCredential(caregiver, revCoverageCred);
  line(`  revocable coverage cred = ${revCoverageCred.slice(0, 28)}… (status index ${COVERAGE_IDX})`);

  // The ED's verify path pairs the issuer-attested proof with a FAIL-CLOSED status check.
  const verifyRevocableCoverage = async (resolver: StatusListResolver): Promise<{ ok: boolean; reason: string }> => {
    const challenge = await requestProof(ed, { schema: revSchema, trustedIssuers: [healthplanId.did] });
    const response = await presentProof(caregiver, challenge);
    const proof = await verifyProof(ed, response, { trustedIssuers: [healthplanId.did], requiredClaims: { coverageActive: true } });
    if (!proof.ok) return { ok: false, reason: `signature/claims: ${proof.reason ?? 'failed'}` };
    const status = await resolver.check(COVERAGE_IDX);
    if (!status.available) return { ok: false, reason: `fail-closed: status unavailable (${status.reason ?? 'unknown'})` };
    if (status.revoked) return { ok: false, reason: 'REFUSED: coverage credential is revoked' };
    return { ok: true, reason: 'signature verifies AND status is live + unrevoked' };
  };

  // Sanity: before revocation the revocable coverage passes both gates.
  const liveResolver = new StatusListResolver(healthplan, { statusListCredential, expectedIssuer: healthplanId.did, maxAgeMs: 0 });
  const preRevoke = await verifyRevocableCoverage(liveResolver);
  check('baseline: unrevoked revocable coverage PASSES (signature + live status)', preRevoke.ok, preRevoke.reason);

  // ── (a) REVOKED coverage caught ────────────────────────────────────────────────────────────────────────
  step('(a) REVOKED coverage is CAUGHT');
  const r = await revokeStatusIndex(healthplan, healthplanId.name, statusListCredential, COVERAGE_IDX);
  check('health-plan set the revocation bit (new list version)', !r.alreadyRevoked && r.listVersion === 2, `v${r.listVersion}`);
  const afterRevoke = await verifyRevocableCoverage(liveResolver);
  check('(a) verify path REFUSES the revoked coverage (StatusListResolver → revoked:true)', !afterRevoke.ok && /revoked/.test(afterRevoke.reason), afterRevoke.reason);

  // ── (b) WIDENED capability refused ───────────────────────────────────────────────────────────────────
  step('(b) a WIDENED delegation is REFUSED at issuance (widening is unrepresentable, not merely rejected)');
  let threw = false;
  let thrownMsg = '';
  try {
    await delegateCapability({
      issuer: caregiver,
      issuerName: caregiverId.name,
      parent: caregiverCap, // grants only { operations:['prove'], resources:['admission'] }
      holder: caregiverId.did,
      child: { invocationTarget: ADMISSION, authority: { operations: ['prove', 'submit'], resources: [ADMISSION] }, caveats: caregiverCaveats },
      registry: reg,
    });
  } catch (e) {
    threw = true;
    thrownMsg = e instanceof Error ? e.message : String(e);
  }
  check('(b) delegateCapability THROWS on widening prove→prove,submit', threw, thrownMsg.slice(0, 80));

  // ── (c) REQUESTER-authored consent ignored ───────────────────────────────────────────────────────────
  step('(c) a REQUESTER-authored consent string is IGNORED — the Warden authors the screen');
  // The "hospital requesting system" supplies its OWN self-serving consent text. It is INPUT EVIDENCE only.
  const requesterSuppliedConsent = 'I authorize Acme Hospital to access my COMPLETE medical record indefinitely.';
  const inputEvidence = { requesterSuppliedConsent }; // recorded, never rendered
  // The screen the caregiver's Signet actually shows is re-derived by the Warden from the disclosure fields.
  const screenShown = wardenAuthorConsent(consentFields);
  check('(c) the consent SCREEN is the Warden-authored string', screenShown === wardenConsent);
  check('(c) the requester-supplied string is NEVER the consent screen', screenShown !== inputEvidence.requesterSuppliedConsent);
  check('(c) the requester string is retained only as input evidence', inputEvidence.requesterSuppliedConsent.length > 0 && screenShown.indexOf('COMPLETE medical record') === -1);

  // ── (d) KEY-ROTATION rotation-safety ─────────────────────────────────────────────────────────────────
  step('(d) KEY ROTATION — a pre-rotation coverage credential STILL verifies (version-pinned resolution)');
  // Issue a coverage credential, capture the signing key epoch, rotate the issuer's keys, then verify the
  // PRE-ROTATION credential. Archon's verifyResponse resolves the key that MATCHES the credential (its epoch),
  // so the old signature still verifies over the stable did:cid. NOTE (the load-bearing distinction the
  // Architect raised): a stock client that resolved the issuer at 'latest' would fetch the NEW key and FAIL —
  // rotation-safety depends on version-pinned resolution, not on the DID being stable alone.
  const rotSchema = await healthplan.keymaster.createSchema(COVERAGE_SCHEMA);
  const rotBound = await healthplan.keymaster.bindCredential(patientId.did, { schema: rotSchema, claims: { type: 'CoverageStatus', coverageActive: true, plan: 'Acme Health PPO' } });
  const rotCred = await healthplan.keymaster.issueCredential(rotBound, { schema: rotSchema });
  await acceptCredential(patient, rotCred);
  const rotVcBefore = await getCredential(patient, rotCred);
  const keyEpochAtSigning = rotVcBefore?.proof?.verificationMethod ?? '';

  const verifyRot = async () => {
    const challenge = await requestProof(ed, { schema: rotSchema, trustedIssuers: [healthplanId.did] });
    const response = await presentProof(patient, challenge);
    return verifyProof(ed, response, { trustedIssuers: [healthplanId.did], requiredClaims: { coverageActive: true } });
  };
  const beforeRot = await verifyRot();
  check('coverage verifies BEFORE rotation', beforeRot.ok, beforeRot.reason ?? '');

  await healthplan.keymaster.setCurrentId(healthplanId.name);
  const rotated = await healthplan.keymaster.rotateKeys();
  check('health-plan issuer rotated its keys', rotated === true);
  const issuerDocAfter = await ed.keymaster.resolveDID(healthplanId.did); // 'latest' resolution (the ED's default)
  const latestKey = (issuerDocAfter.didDocument?.verificationMethod?.[0]?.id ?? '');
  check('the issuer\'s CURRENT (latest) key epoch advanced past the signing epoch', latestKey.length > 0 && keyEpochAtSigning.length > 0 && latestKey !== keyEpochAtSigning, `signed@${keyEpochAtSigning.split('#').pop() ?? '?'} latest@${latestKey.split('#').pop() ?? '?'}`);

  const afterRot = await verifyRot();
  check('(d) the PRE-ROTATION coverage credential STILL verifies after rotation (version-pinned)', afterRot.ok, afterRot.reason ?? '');

  // ── (e) OFFLINE revocation fails-closed ──────────────────────────────────────────────────────────────
  step('(e) OFFLINE revocation FAILS CLOSED (an unresolvable status list → available:false → verify fails)');
  const badStatusListDid = 'did:cid:bagaaieranotarealstatuslist000000000000000000000000000000000';
  const offlineResolver = new StatusListResolver(healthplan, { statusListCredential: badStatusListDid, expectedIssuer: healthplanId.did, maxAgeMs: 60_000 });
  const offlineCheck = await offlineResolver.check(COVERAGE_IDX);
  check('unresolvable status list → check returns available:false (never fails open)', offlineCheck.available === false && offlineCheck.revoked === false, offlineCheck.reason ?? '');
  const offlineVerify = await verifyRevocableCoverage(offlineResolver);
  check('(e) the verify path FAILS CLOSED when revocation cannot be resolved', !offlineVerify.ok && /fail-closed/.test(offlineVerify.reason), offlineVerify.reason);

  // ── Verdict ──────────────────────────────────────────────────────────────────────────────────────────
  line('');
  if (failures === 0) {
    line(`✅ PASS — ED-admission verifier scenario green (${realMode ? 'REAL Architect credential' : 'local stub'} for leg 3)`);
    process.exit(0);
  } else {
    line(`❌ FAIL — ${failures} check(s) off-target`);
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
