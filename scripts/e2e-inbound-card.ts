/**
 * e2e: SECURE INBOUND-CARD IMPORT — DMZ as a hard, un-shortcuttable precondition (Aegis ask).
 *
 * The invariant: a cross-node credential card is verified ONLY inside an ephemeral, peerless DMZ; on
 * success we keep ONLY the verified closure (the `issued` leaf), never the raw foreign ops; the DMZ is
 * always torn down; accept promotes the closure into the member's own vault (no foreign gatekeeper ops).
 *
 *   1. verifyForeignCredential: a valid foreign chain → verified + leaf; a missing/invalid chain → refused;
 *      the DMZ is torn down on BOTH paths (assertNothingSurvives).
 *   2. promoteVerifiedCard: the closure lands as an owner-scoped, private vault artefact (issued leaf); no
 *      ops touch the private gatekeeper.
 *   3. InboundCardStore keeps the closure SERVER-SIDE (stripped from the wire list); accept reads it.
 *   4. source-scan: the accept route is session + owner + verification gated (fail-closed) and NOT co-signed;
 *      the receipt handler routes cross-node through the DMZ and never persists raw ops.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   [HEARTHOLD_DMZ_URL=http://<peerless>:4224] node --experimental-strip-types scripts/e2e-inbound-card.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  DmzSession,
  verifyForeignCredential,
  PROTOCOL_VERSION,
  IssuedStore,
  type KeymasterHandle,
  type CredentialDeliveryMessage,
} from '@hearthold/core';
import { promoteVerifiedCard } from '@hearthold/warden/credential-vault';
import { InboundCardStore, type StoredInboundCard } from '@hearthold/warden/inbound-card-store';
import { VaultStore } from '@hearthold/warden/store';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const SCHEMA = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { type: { type: 'string' }, club: { type: 'string' } }, required: ['type'], additionalProperties: true } as const;

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-inbound-card-e2e';
  const dataRoot = mkdtempSync(join(tmpdir(), 'hearthold-inbound-'));
  const config = { ...base, dataRoot };
  // DMZ target: a confirmed peerless node (Aegis's node B) or the flaxlap raw gatekeeper stand-in via the
  // explicit assumePeerless escape hatch (:4224), exactly like e2e-dmz.
  const realPeerless = process.env.HEARTHOLD_DMZ_URL;
  const dmzUrl = realPeerless ?? base.nodeUrl.replace(':4222', ':4224');

  try {
    step('Issue a VC (issuer=warden id → subject=sovereign id) and export the operation chain');
    const issuer: KeymasterHandle = await openKeymaster('warden', config, pass);
    const subject: KeymasterHandle = await openKeymaster('sovereign', config, pass);
    const issuerId = await ensureIdentity(issuer, config);
    const subjectId = await ensureIdentity(subject, config);
    await issuer.keymaster.setCurrentId(IDENTITY_NAME.warden);
    const schemaDid = await issuer.keymaster.createSchema(SCHEMA);
    const bound = await issuer.keymaster.bindCredential(subjectId.did, { schema: schemaDid, claims: { type: 'Membership', club: 'Hearthold' } });
    const credentialDid = await issuer.keymaster.issueCredential(bound, { schema: schemaDid });
    const [issuerOps] = await issuer.gatekeeper.exportDIDs([issuerId.did]);
    const [schemaOps] = await issuer.gatekeeper.exportDIDs([schemaDid]);
    const [vcOps] = await issuer.gatekeeper.exportDIDs([credentialDid]);
    check('VC + schema + issuer ops exported', !!vcOps?.length && !!schemaOps?.length && !!issuerOps?.length);

    // A DMZ factory that CAPTURES the session so we can assert it is always torn down.
    let lastSession: DmzSession | undefined;
    const openDmz = async (): Promise<DmzSession> => {
      lastSession = await DmzSession.open({
        dmzNodeUrl: dmzUrl,
        role: 'warden',
        config,
        passphrase: pass,
        ...(process.env.HEARTHOLD_DMZ_API_KEY ? { apiKey: process.env.HEARTHOLD_DMZ_API_KEY } : {}),
        ...(realPeerless ? {} : { assumePeerless: true }),
      });
      return lastSession;
    };
    const msg = (ops: CredentialDeliveryMessage['ops']): CredentialDeliveryMessage => ({
      type: 'hearthold/credential-delivery',
      version: PROTOCOL_VERSION,
      credentialDid,
      schemaDid,
      ops,
    });

    step(`verifyForeignCredential — a VALID foreign chain verifies in the DMZ (${realPeerless ? 'confirmed-peerless' : 'stand-in via escape hatch'}) and keeps only the closure`);
    const good = await verifyForeignCredential(openDmz, msg([issuerOps!, schemaOps!, vcOps!]));
    if (!good.ok) process.stdout.write(`    reason: ${good.reason}\n`);
    check('verified (chain ok)', good.ok === true);
    check('the payload was readable here → contentReadable true (full claims)', good.contentReadable === true);
    check('the closure is an issued leaf anchored on the ISSUER DID', good.leaf?.issuer === issuerId.did && good.leaf?.trustClass === 'issued');
    check('the closure records the credential DID', good.leaf?.credentialDid === credentialDid);
    check('the DMZ was torn down after a SUCCESSFUL verify (nothing survives)', lastSession?.assertNothingSurvives().destroyed === true);
    const goodLeaf = good.leaf!;

    step('verifyForeignCredential — a card whose chain does NOT verify is REFUSED (fail closed), DMZ still torn down');
    // A credential DID that resolves NOWHERE (no ops carry it) — the chain cannot verify on any target,
    // including the shared-DB stand-in (a "missing VC ops" negative would false-pass on the stand-in, whose
    // DB already holds the origin's VC; a genuinely non-existent DID is the target-independent negative).
    lastSession = undefined;
    const bogus: CredentialDeliveryMessage = {
      type: 'hearthold/credential-delivery',
      version: PROTOCOL_VERSION,
      credentialDid: 'did:test:nonexistent-inbound-card',
      schemaDid,
      ops: [schemaOps!],
    };
    const bad = await verifyForeignCredential(openDmz, bogus);
    check('unverified (chain could not resolve the VC)', bad.ok === false && !bad.leaf);
    check('a reason is given', typeof bad.reason === 'string' && bad.reason.length > 0);
    check('the DMZ was torn down after a FAILED verify too', lastSession?.assertNothingSurvives().destroyed === true);

    step('issuer authenticity — the receipt cross-check: issuer resolves on OUR federated gatekeeper vs sender-asserted');
    // The receipt handler cross-checks the closure's issuer against the recipient's OWN federated resolution
    // (this is the exact call): a resolvable issuer is issuer-authentic; a non-resolvable one is only
    // chain-consistent (sender-asserted) — the peerless DMZ can't distinguish these, our own gatekeeper can.
    const issuerResolves = await issuer.keymaster.resolveDID(goodLeaf.issuer).then((d) => Boolean(d.didDocument?.id)).catch(() => false);
    check('a real issuer resolves on our federated gatekeeper → issuer-authentic', issuerResolves === true);
    const bogusResolves = await issuer.keymaster.resolveDID('did:test:forged-issuer').then((d) => Boolean(d.didDocument?.id)).catch(() => false);
    check('a sender-asserted (unresolvable) issuer → chain-consistent', bogusResolves === false);

    step('promoteVerifiedCard — the verified closure lands as an owner-scoped, private vault artefact (no foreign ops)');
    const ownerDid = subjectId.did;
    const artefactId = await promoteVerifiedCard(issuer, { wardenDid: issuerId.did, ownerDid, leaf: goodLeaf, authenticity: 'issuer-authentic', contentReadable: true });
    const stored = await new VaultStore(issuer.dataFolder).get(artefactId);
    check('artefact written to the vault', !!stored);
    check('owner-scoped to the recipient member, private scope', stored?.owner === ownerDid && stored?.scope === 'private');
    check('linked back to the signed credential as an issued leaf', stored?.metadata?.trustClass === 'issued' && stored?.metadata?.credentialDid === credentialDid && stored?.metadata?.source === 'inbound-card');
    check('the authenticity + readability verdicts are carried into the artefact', stored?.metadata?.authenticity === 'issuer-authentic' && stored?.metadata?.contentReadable === true);
    check('also recorded as a first-class issued evidence leaf', (await new IssuedStore(issuer.dataFolder).get(credentialDid)) !== undefined);

    step('InboundCardStore — the closure is kept SERVER-SIDE and stripped from the wire list');
    const cardStore = new InboundCardStore(dataRoot);
    const verifiedCard: StoredInboundCard = { credentialDid, schemaDid, from: issuerId.did, verified: true, receivedAt: new Date().toISOString(), owner: ownerDid, closure: goodLeaf, versionId: good.versionId };
    const unverifiedCard: StoredInboundCard = { credentialDid: 'did:test:unverified', schemaDid, from: issuerId.did, verified: false, receivedAt: new Date().toISOString(), owner: ownerDid };
    cardStore.put(verifiedCard);
    cardStore.put(unverifiedCard);
    const wire = cardStore.list(ownerDid);
    check('the wire list omits the closure + versionId (server-side only)', wire.every((c) => !('closure' in c) && !('versionId' in c)));
    check('getStored returns the full closure for accept', cardStore.getStored(credentialDid)?.closure?.credentialDid === credentialDid);
    check('an unverified card has NO closure (accept will refuse it, fail-closed)', cardStore.getStored('did:test:unverified')?.closure === undefined);

    step('source-scan — the accept route is session+owner+verification gated (fail-closed), NOT co-signed; receipt never keeps ops');
    const control = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/warden/src/control.ts'), 'utf8');
    const acceptBlock = control.slice(control.indexOf("'POST /api/card/accept'"), control.indexOf("'POST /api/card/accept'") + 1400);
    check('accept is session-gated (effectiveViewer)', /effectiveViewer\(ctx\)/.test(acceptBlock));
    check('accept is owner-scoped (card.owner !== viewer → not available)', /card\.owner !== viewer/.test(acceptBlock));
    check('accept is verification-gated (refuse !verified || !closure)', /!card\.verified \|\| !card\.closure/.test(acceptBlock));
    check('accept promotes the closure, not raw ops', /promoteVerifiedCard\(handle, \{/.test(acceptBlock) && /leaf: card\.closure/.test(acceptBlock));
    check('accept is NOT co-signed (no coSign in the accept block)', !/coSign\(/.test(acceptBlock));
    const receiptBlock = control.slice(control.indexOf("'hearthold/credential-delivery'"), control.indexOf("'hearthold/credential-delivery'") + 2200);
    check('the receipt handler routes cross-node through verifyForeignCredential', /verifyForeignCredential\(openDmz, m\)/.test(receiptBlock));
    check('the receipt handler never persists m.ops (closure only)', !/closure:\s*m\.ops|ops:\s*m\.ops/.test(control) && /StoredInboundCard/.test(control));
    check('the receipt handler cross-checks the issuer against our OWN federated resolution', /resolveDID\(closure\.issuer\)/.test(control) && /issuerResolves \? 'issuer-authentic' : 'chain-consistent'/.test(control));
    check('card/pass ships the issuer ops for cross-node DMZ verification (includeIssuerOps)', /includeIssuerOps: true/.test(control));
    const declineBlock = control.slice(control.indexOf("'POST /api/card/decline'"), control.indexOf("'POST /api/card/decline'") + 700);
    check('card/decline is session+owner gated and removes without importing', /effectiveViewer\(ctx\)/.test(declineBlock) && /card\.owner !== viewer/.test(declineBlock) && /inboundCards\.remove/.test(declineBlock) && !/promoteVerifiedCard/.test(declineBlock));

    step('source-scan — a cross-audience VC is accepted as a PROVENANCE closure, not declined (option 2)');
    const cd = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/core/src/credential-delivery.ts'), 'utf8');
    check('verifyForeignCredential no longer fail-closes on an unreadable payload', !/return \{ ok: false, reason: 'chain verified but the credential closure was unreadable/.test(cd));
    check('an unreadable cross-audience VC → provenance-only closure (contentReadable:false, issuer from controller)', /contentReadable: false/.test(cd) && /controller/.test(cd));
    check('a readable payload → contentReadable:true (full claims)', /contentReadable: true/.test(cd));
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ inbound-card: cross-node verified in the DMZ (closure kept, ops discarded, always torn down); accept is fail-closed + owner-scoped\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-inbound-card: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
