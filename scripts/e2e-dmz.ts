/**
 * e2e: THE DMZ SESSION — verification without republication (closes B6), now with TARGET ISOLATION.
 *
 * Two independent guarantees, both required:
 *   - CAPABILITY CONFINEMENT (structural): the node's own handle is a PrivateGatekeeper with no import
 *     methods, so importing foreign ops into it is a compile error. Only a DmzSession can import.
 *   - TARGET ISOLATION (runtime): before any import is possible, `DmzSession.open` interrogates the target
 *     via `listRegistries()` and REFUSES a peered or unverifiable one. Point the importer at a peered node
 *     and it fails closed — the compiler can't catch that, so the runtime check must.
 *
 * flaxlap is PEERED, so a default DMZ open against it is now REFUSED — that is the check working. The
 * lifecycle (import/verify/teardown) runs against a genuinely peerless target if HEARTHOLD_DMZ_URL is set
 * (Aegis's node B), otherwise against flaxlap under an EXPLICIT `assumePeerless` escape hatch — the
 * sanctioned, loud, per-session acknowledgement of a stand-in. See docs/dmz/RESULTS.md.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   [HEARTHOLD_DMZ_URL=http://<peerless>:4224] node --experimental-strip-types scripts/e2e-dmz.ts
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  DmzSession,
  DmzSessionClosedError,
  assertPeerlessTarget,
  PeeredTargetError,
  UndeterminedTargetError,
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
  const realPeerless = process.env.HEARTHOLD_DMZ_URL; // set by Aegis to point at node B (a real peerless node)
  const standInUrl = base.nodeUrl.replace(':4222', ':4224'); // flaxlap raw gatekeeper — PEERED, a stand-in
  const lifecycleUrl = realPeerless ?? standInUrl;

  step('assertPeerlessTarget — the decision logic, in isolation (deterministic)');
  check('a peerless target (["local"]) is accepted', (await assertPeerlessTarget({ listRegistries: async () => ['local'] }, 'stub').then((r) => !r.assumed).catch(() => false)) === true);
  {
    let e: unknown;
    await assertPeerlessTarget({ listRegistries: async () => ['local', 'hyperswarm'] }, 'stub').catch((x) => (e = x));
    check('a peered target (adds "hyperswarm") is REFUSED (PeeredTargetError)', e instanceof PeeredTargetError);
  }
  {
    let e: unknown;
    await assertPeerlessTarget({ listRegistries: async () => { throw new Error('down'); } }, 'stub').catch((x) => (e = x));
    check('an unanswerable target is REFUSED (UndeterminedTargetError — fail closed on unknown)', e instanceof UndeterminedTargetError);
  }
  check('the escape hatch bypasses the check (assumed=true), by explicit opt-in only', (await assertPeerlessTarget({ listRegistries: async () => ['hyperswarm'] }, 'stub', { assumePeerless: true })).assumed === true);

  step('PEERED-TARGET — a DMZ session against a peered gatekeeper (flaxlap) is REFUSED before any import');
  let peeredSession: DmzSession | undefined;
  let peeredErr: unknown;
  try {
    peeredSession = await DmzSession.open({ dmzNodeUrl: base.nodeUrl, role: 'sovereign', config: cfg('peered'), passphrase: pass });
  } catch (e) {
    peeredErr = e;
  }
  check('open against flaxlap is refused (PeeredTargetError)', peeredErr instanceof PeeredTargetError);
  check('NO SESSION exists after a peered refusal (no import is reachable)', peeredSession === undefined);

  step('UNDETERMINED-TARGET — a DMZ session against an unreachable gatekeeper is REFUSED');
  let undetSession: DmzSession | undefined;
  let undetErr: unknown;
  try {
    undetSession = await DmzSession.open({ dmzNodeUrl: 'http://127.0.0.1:1', role: 'sovereign', config: cfg('undet'), passphrase: pass });
  } catch (e) {
    undetErr = e;
  }
  check('open against an unreachable target is refused (UndeterminedTargetError)', undetErr instanceof UndeterminedTargetError);
  check('NO SESSION exists after an undetermined refusal', undetSession === undefined);

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

  step('Provision issuer + subject; issuer issues a VC (signed by key-1) then ROTATES — the exported chain spans two epochs');
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
  check('a VC exists, signed by the issuer key-1', /#key-1$/.test(String(vc?.proof?.verificationMethod ?? '')));
  // Rotate BEFORE export so the chain we ship to the DMZ actually CONTAINS the rotation. A DMZ verifies what
  // is imported INTO it, never what the own node does afterwards — the shared-DB stand-in used to leak the
  // own-node rotation into the "DMZ" and mask exactly the separation B6 exists to prove. (Caught by Aegis's
  // live Path-A run against a genuinely separate peerless DMZ.)
  await issuer.keymaster.setCurrentId(IDENTITY_NAME.warden);
  await issuer.keymaster.rotateKeys();
  const [issuerOps] = await issuer.gatekeeper.exportDIDs([issuerId.did]); // 2 ops: create + rotation
  const [schemaOps] = await issuer.gatekeeper.exportDIDs([schemaDid]);
  const [vcOps] = await issuer.gatekeeper.exportDIDs([vcDid]);
  check('the exported issuer chain spans two epochs (create + rotation)', (issuerOps?.length ?? 0) >= 2);

  step(`PEERLESS-TARGET — lifecycle against ${realPeerless ? 'a CONFIRMED peerless node (HEARTHOLD_DMZ_URL)' : 'the flaxlap stand-in via the explicit assumePeerless escape hatch'}`);
  const session = await DmzSession.open({
    dmzNodeUrl: lifecycleUrl,
    ...(process.env.HEARTHOLD_DMZ_API_KEY ? { apiKey: process.env.HEARTHOLD_DMZ_API_KEY } : {}),
    // Real peerless target → interrogate it (no escape hatch). Stand-in → explicit, loud escape hatch.
    ...(realPeerless ? {} : { assumePeerless: true }),
    role: 'sovereign',
    config: cfg('sub'),
    passphrase: pass,
  });
  check(realPeerless ? 'opened against a confirmed-peerless target (interrogated, no escape hatch)' : 'opened against the stand-in via the explicit escape hatch', session.isOpen === true);

  step('IMPORT the multi-epoch chain → VERIFY (across the rotation, in the DMZ) → TEARDOWN');
  await session.import([issuerOps, schemaOps, vcOps], [issuerId.did, schemaDid, vcDid]);
  check('the DMZ tracked the imported DIDs', session.scope.length === 3);
  const vcChain = await session.verifyChain(vcDid);
  check('the VC chain verifies in the DMZ', vcChain.ok === true && typeof vcChain.versionId === 'string');
  // The DMZ verifies exactly what was imported into it: the 2-epoch issuer chain resolves to v2, and the VC
  // signed by the RETIRED key-1 still verifies against it (rotation-safety, entirely inside the DMZ).
  const issuerChain = await session.verifyChain(issuerId.did);
  check('the issuer chain verifies ACROSS THE ROTATION in the DMZ (both epochs imported)', issuerChain.ok === true && (issuerChain.versionSequence ?? 0) >= 2);
  check('the VC signed by the retired key-1 still verifies against the rotated chain', (await session.verifyProof(vc!)) === true);
  session.teardown();
  const after = session.assertNothingSurvives();
  check('the session is destroyed and holds no residue', after.destroyed === true && after.residue.length === 0);
  let closedThrew = false;
  try {
    await session.verifyChain(vcDid);
  } catch (e) {
    closedThrew = e instanceof DmzSessionClosedError;
  }
  check('a torn-down session refuses further verification (fail closed)', closedThrew);

  step('B6 (structural): the node’s own handle cannot import foreign ops — a COMPILE error');
  const ownHandle: KeymasterHandle = subject;
  void (async () => {
    // @ts-expect-error B6 STRUCTURAL: PrivateGatekeeper omits importDIDs — importing into the node's own gatekeeper is a type error
    await ownHandle.gatekeeper.importDIDs([]);
  });
  check('the node’s own gatekeeper cannot import foreign ops (PrivateGatekeeper — @ts-expect-error, build-enforced)', true);

  process.stdout.write(
    failures === 0
      ? '\n✓ dmz: capability confined (by type) AND target isolated (peerless-verified at open); peered/undetermined targets refused\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-dmz: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
