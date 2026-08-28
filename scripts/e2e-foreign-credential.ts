/**
 * e2e: FOREIGN CREDENTIAL EXCHANGE — an Archon identity issues to a subject OUTSIDE Archon, and pushes the
 * signed credential WHOLE over DIDComm (issue-credential/3.0 · @didcid 0.6.3). The Blazon *publish*
 * transport (docs/blazon-didcomm-disclosure.md).
 *
 * Proves four things against the live node:
 *   1. Deny-by-default — the disclosure crosses `decideRelease` FIRST; a SEALED fact under a mere CHALLENGE
 *      tier is refused, and NOTHING is minted or sent (no credentialDid).
 *   2. Foreign issuance — under a clearing gate, the Warden mints a VC whose `credentialSubject.id` is a
 *      NON-`did:cid` identifier (a `did:web` a non-Archon agent presents), and gets back an asset DID.
 *   3. Self-contained & issuer-attested — that VC carries the foreign subject verbatim, is signed by the
 *      Warden (`issuer`), embeds its own asset `id` (#108), and carries a `proof`. This is exactly what a
 *      foreign verifier checks after resolving the issuer's did:cid — never the sender's word.
 *   4. Delivery reaches a foreign inbox — the SIGNED CREDENTIAL ITSELF arrives in the recipient's DIDComm
 *      mailbox as an issue-credential/3.0 message; the recipient reads the whole VC from the attachment
 *      (issuer-signed, foreign subject), and `acceptCredentialDidComm` returns FALSE — "show, don't accept",
 *      because a foreign-subject VC has nothing to store in an Archon wallet; trust is by issuer signature.
 *
 * Isolated data roots; run:  npm run e2e:foreign-credential
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  DidCommTransport,
  discloseToForeignVerifier,
  Sensitivity,
  AuthzTier,
  DisclosureMode,
  type ReleaseContext,
} from '@hearthold/core';

const ISSUE_CREDENTIAL_TYPE = 'https://didcomm.org/issue-credential/3.0/issue-credential';
/** A non-Archon identifier — what a foreign agent presents. NON-`did:cid` ⇒ the genuine foreign path. */
const FOREIGN_SUBJECT = 'did:web:bob.hearthold.example';

const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { type: { type: 'string' }, claim: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
} as const;

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

/**
 * Loose view of a `receiveDidComm` result: the unpacked DIDComm message lives under `.message` (type / body /
 * attachments), with the mailbox `id` and authcrypt `metadata` alongside.
 */
type InnerMessage = {
  type?: string;
  body?: { credential_did?: string; comment?: string };
  attachments?: Array<{ data?: { json?: Record<string, unknown> } }>;
};
type Unpacked = { id?: string; message?: InnerMessage };
type Vc = { id?: string; issuer?: string; credentialSubject?: { id?: string }; proof?: unknown };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-foreign-cred-e2e';
  const cfg = (s: string): ReturnType<typeof loadConfig> => ({ ...base, dataRoot: join(base.dataRoot, s) });

  step('Provision issuer (Warden) + a foreign inbox (recipient on its own data root)');
  const issuer = await openKeymaster('warden', cfg('issuer'), pass);
  const inbox = await openKeymaster('emissary', cfg('inbox'), pass);
  const issuerId = await ensureIdentity(issuer, cfg('issuer'));
  const inboxId = await ensureIdentity(inbox, cfg('inbox'));
  check('issuer + inbox provisioned', Boolean(issuerId.did && inboxId.did));

  // The inbox must publish a DIDComm endpoint so the issuer's push can route to it. (This also exercises the
  // capability preflight added earlier — ready() probes the node first.)
  await new DidCommTransport(inbox, IDENTITY_NAME.emissary, base.nodeUrl).ready();
  await new DidCommTransport(issuer, IDENTITY_NAME.warden, base.nodeUrl).ready();

  await issuer.keymaster.setCurrentId(IDENTITY_NAME.warden);
  const schemaDid = await issuer.keymaster.createSchema(SCHEMA);

  // ── 1. Deny-by-default — the gate refuses before any mint/send ──────────────────────────────────────────
  step('Deny-by-default: a SEALED fact under a CHALLENGE tier is refused, nothing minted');
  const denyCtx: ReleaseContext = {
    sensitivity: Sensitivity.SEALED,
    tier: AuthzTier.CHALLENGE,
    delegationValid: true,
    mode: DisclosureMode.SELECTIVE,
    disclosureSatisfiable: true,
  };
  const denied = await discloseToForeignVerifier(issuer, IDENTITY_NAME.warden, denyCtx, {
    toDid: inboxId.did,
    subjectDid: FOREIGN_SUBJECT,
    schemaDid,
    claims: { type: 'BlazonFact', claim: 'sealed-secret' },
  });
  check('release denied (deny-by-default ladder)', denied.released === false);
  check('nothing minted on denial (no credentialDid)', denied.credentialDid === undefined);
  check('denial reason surfaced for audit', /release denied/.test(denied.reason));

  // ── 2 + 3. Foreign issuance under a clearing gate → self-contained issuer-attested VC ───────────────────
  step('Foreign issuance: Warden issues to a NON-Archon subject under a clearing gate');
  const allowCtx: ReleaseContext = {
    sensitivity: Sensitivity.LOW,
    tier: AuthzTier.HUMAN,
    delegationValid: true,
    mode: DisclosureMode.SELECTIVE,
    disclosureSatisfiable: true,
  };
  const validUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const out = await discloseToForeignVerifier(issuer, IDENTITY_NAME.warden, allowCtx, {
    toDid: inboxId.did,
    subjectDid: FOREIGN_SUBJECT,
    schemaDid,
    claims: { type: 'BlazonFact', claim: 'over-18' },
    validUntil,
    comment: 'Blazon publish: age assertion',
  });
  check('release allowed and a credential DID returned', out.released === true && typeof out.credentialDid === 'string');
  const credentialDid = out.credentialDid!;

  step('Self-contained & issuer-attested: the minted VC is what a foreign verifier checks');
  await issuer.keymaster.setCurrentId(IDENTITY_NAME.warden);
  const vc = (await issuer.keymaster.getCredential(credentialDid)) as Vc | null;
  check('issuer can read its own VC (encrypted-to-issuer)', Boolean(vc));
  check('credentialSubject.id is the FOREIGN subject, verbatim', vc?.credentialSubject?.id === FOREIGN_SUBJECT);
  check('issuer is the Warden — the signature a foreign verifier trusts', vc?.issuer === issuerId.did);
  check('VC embeds its own asset id (#108, self-naming)', vc?.id === credentialDid);
  check('VC carries a proof (signed, off-network verifiable)', Boolean(vc?.proof));

  // ── 4. Delivery reaches the foreign inbox as a whole, signed VC ─────────────────────────────────────────
  step('Delivery: the signed credential arrives WHOLE in the recipient DIDComm mailbox');
  let inner: InnerMessage | undefined;
  for (let attempt = 0; attempt < 6 && !inner; attempt += 1) {
    if (attempt > 0) await sleep(500);
    const results = (await inbox.keymaster.receiveDidComm({ name: IDENTITY_NAME.emissary })) as Unpacked[];
    const hit = results.find(
      (r) => r.message?.type === ISSUE_CREDENTIAL_TYPE && r.message?.body?.credential_did === credentialDid,
    );
    inner = hit?.message;
  }
  check('issue-credential/3.0 message arrived at the foreign inbox', Boolean(inner));
  const attached = inner?.attachments?.[0]?.data?.json as Vc | undefined;
  check('the WHOLE VC travelled in-band (attachment), not by reference', Boolean(attached));
  check('attachment: foreign subject preserved end-to-end', attached?.credentialSubject?.id === FOREIGN_SUBJECT);
  check('attachment: Warden-signed (issuer) — recipient verifies this, not the sender word', attached?.issuer === issuerId.did);
  check('attachment: proof present — the off-network trust anchor', Boolean(attached?.proof));
  check('optional comment carried through', inner?.body?.comment === 'Blazon publish: age assertion');

  if (inner) {
    // A foreign-subject VC has NOTHING to accept into an Archon wallet — trust is the issuer signature on the
    // attachment above, not a wallet-store. acceptCredentialDidComm takes the INNER message; for a non-subject
    // party it either returns false (foreign/undecryptable) or throws trying to decrypt a VC encrypted to the
    // issuer's audience. Both mean the same thing: not accepted. A real non-Archon holder never calls this —
    // it reads the attachment and verifies the issuer's did:cid. We assert only that acceptance did NOT happen.
    let accepted: boolean;
    try {
      accepted = await inbox.keymaster.acceptCredentialDidComm(inner);
    } catch {
      accepted = false; // undecryptable foreign-subject VC — cannot be stored, which is exactly the point
    }
    check('recipient does NOT accept a foreign-subject VC into a wallet (show, don\'t accept)', accepted !== true);
  }

  process.stdout.write(failures === 0 ? '\nPASS\n' : `\nFAIL (${failures})\n`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
