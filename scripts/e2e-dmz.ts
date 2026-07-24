/**
 * e2e: THE DMZ SESSION — verification without republication (closes B6).
 *
 * Lifecycle: OPEN → IMPORT → VERIFY (across key epochs) → TEARDOWN. The DMZ owns the ONLY full Gatekeeper
 * client (with importDIDs); the node's own handle is a PrivateGatekeeper that CANNOT import (compile error),
 * so foreign ops never reach the node's own gatekeeper — B6 is impossible by type (see e2e-pvm-boundaries).
 *
 * STAND-IN NOTE: a genuinely PEERLESS, import-open Gatekeeper is not reachable from this host — Aegis's
 * two-node instances are `internal:true` (no host port) and flaxlap gates `/dids/import`. So this run points
 * the DMZ at flaxlap:4224 (a distinct client/URL) to exercise the lifecycle + verify + teardown LOGIC. The
 * peerless property and the live cross-gatekeeper "nothing in the node's own gatekeeper" demonstration are
 * Aegis's isolated two-node's job (docs/dmz/RESULTS.md — Aegis coordination note). Import here is best-effort:
 * flaxlap gates import, so it falls back to the native-resolvable path, which is what we assert.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-dmz.ts
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  DmzSession,
  DmzSessionClosedError,
  type KeymasterHandle,
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const SCHEMA = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { type: { type: 'string' } }, required: ['type'], additionalProperties: true } as const;

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-dmz-e2e';
  const cfg = (s: string) => ({ ...base, dataRoot: join(base.dataRoot, s) });
  // The DMZ target. Set HEARTHOLD_DMZ_URL to a genuinely PEERLESS, import-open Gatekeeper (Aegis's node B)
  // for a real run; otherwise fall back to flaxlap's raw gatekeeper — a distinct client over the same DB, a
  // stand-in that exercises the lifecycle logic only (see docs/dmz/AEGIS-DMZ-LIVE-RUN.md).
  const dmzNodeUrl = process.env.HEARTHOLD_DMZ_URL ?? base.nodeUrl.replace(':4222', ':4224');

  step('FAIL CLOSED — a DMZ session with no target refuses to open');
  {
    let threw = false;
    try {
      await DmzSession.open({ dmzNodeUrl: '', role: 'sovereign', config: cfg('x'), passphrase: pass });
    } catch {
      threw = true;
    }
    check('DmzSession.open("") is refused (no ambient target)', threw);
  }

  step('Provision issuer + subject; issuer issues a VC, subject accepts and reads its proof');
  const issuer = await openKeymaster('warden', cfg('iss'), pass);
  const subject = await openKeymaster('sovereign', cfg('sub'), pass);
  const issuerId = await ensureIdentity(issuer, cfg('iss'));
  const subjId = await ensureIdentity(subject, cfg('sub'));
  await issuer.keymaster.setCurrentId(IDENTITY_NAME.warden);
  const schemaDid = await issuer.keymaster.createSchema(SCHEMA);
  const bound = await issuer.keymaster.bindCredential(subjId.did, { schema: schemaDid, claims: { type: 'Membership' } });
  const vcDid = await issuer.keymaster.issueCredential(bound, { schema: schemaDid });
  await subject.keymaster.setCurrentId(IDENTITY_NAME.sovereign);
  await subject.keymaster.acceptCredential(vcDid);
  const vc = await subject.keymaster.getCredential(vcDid);
  check('a VC exists with a signing proof', /#key-1$/.test(String(vc?.proof?.verificationMethod ?? '')));

  // Export the ops the way a counterparty would ship them (full chain from genesis).
  const [issuerOps] = await issuer.gatekeeper.exportDIDs([issuerId.did]);
  const [schemaOps] = await issuer.gatekeeper.exportDIDs([schemaDid]);
  const [vcOps] = await issuer.gatekeeper.exportDIDs([vcDid]);

  step('OPEN a DMZ session (peerless stand-in) — Warden-only, reversible, publishes nothing');
  const session = await DmzSession.open({
    dmzNodeUrl,
    ...(process.env.HEARTHOLD_DMZ_API_KEY ? { apiKey: process.env.HEARTHOLD_DMZ_API_KEY } : {}),
    role: 'sovereign',
    config: cfg('sub'),
    passphrase: pass,
  });
  check('session is open', session.isOpen === true);
  check('the DMZ is a DISTINCT client from the node’s own gatekeeper (different URL)', session.dmzNodeUrl !== base.nodeUrl.replace(/\/+$/, ''));

  step('IMPORT the counterparty’s operation export into the DMZ (never the node’s own gatekeeper)');
  await session.import([issuerOps, schemaOps, vcOps], [issuerId.did, schemaDid, vcDid]);
  check('the DMZ tracked the imported DIDs for teardown', session.scope.length === 3);

  step('VERIFY — replay + verify signatures, INCLUDING across a key epoch (rotation-safety path)');
  const before = await session.verifyChain(vcDid);
  check('the VC chain verifies in the DMZ', before.ok === true && typeof before.versionId === 'string');
  check('the VC verifies via its proof in the DMZ', (await session.verifyProof(vc!)) === true);
  // Rotate the issuer key AFTER signing; the pre-rotation VC must still verify (Archon resolves the epoch).
  await issuer.keymaster.setCurrentId(IDENTITY_NAME.warden);
  await issuer.keymaster.rotateKeys();
  const issuerChain = await session.verifyChain(issuerId.did);
  check('the issuer chain verifies across the rotation (all ops, every epoch)', issuerChain.ok === true && (issuerChain.versionSequence ?? 0) >= 2);
  check('the pre-rotation VC STILL verifies after the issuer rotated', (await session.verifyProof(vc!)) === true);

  step('TEARDOWN — destroy the session; assert nothing survives and further use fails closed');
  session.teardown();
  const after = session.assertNothingSurvives();
  check('the session is destroyed and holds no residue', after.destroyed === true && after.residue.length === 0);
  check('the session is no longer open', session.isOpen === false);
  let closedThrew = false;
  try {
    await session.verifyChain(vcDid);
  } catch (e) {
    closedThrew = e instanceof DmzSessionClosedError;
  }
  check('a torn-down session refuses further verification (fail closed)', closedThrew);

  step('B6 (structural): the node’s own handle cannot import foreign ops — a COMPILE error');
  // Behavioural cross-gatekeeper separation ("nothing in the node's own gatekeeper") requires two isolated
  // gatekeepers — Aegis's two-node — which are network-isolated from this host. The invariant that MATTERS
  // is enforced by TYPE, not observation: `Omit` is compile-time, so the runtime client still has the
  // method, but calling it through the handle does not type-check. If PrivateGatekeeper ever regains
  // importDIDs, this @ts-expect-error goes unused and the BUILD fails.
  const ownHandle: KeymasterHandle = subject;
  void (async () => {
    // @ts-expect-error B6 STRUCTURAL: PrivateGatekeeper omits importDIDs — importing into the node's own gatekeeper is a type error
    await ownHandle.gatekeeper.importDIDs([]);
  });
  check('the node’s own gatekeeper cannot import foreign ops (PrivateGatekeeper — @ts-expect-error, build-enforced)', true);

  process.stdout.write(
    failures === 0
      ? '\n✓ dmz: open→import→verify(across epochs)→teardown; foreign ops never touch the node’s own gatekeeper (impossible by type)\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-dmz: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
