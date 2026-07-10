/**
 * e2e: Sevenfold forge → present → burn (the Warden control-plane logic behind /api/forge + /api/present).
 *
 * Forge: assemble witnessed vault data into a minted Attestation scroll (LOW/witnessed clears at
 * STANDING — no step-up). Present: the scroll verifies once and BURNS; a second presentation is refused
 * (single-use, enforced verifier-side via the same SpentTxnStore as e2e:scroll-burn). A forge with no
 * supporting artefacts is denied (not thrown).
 *
 * Live (needs the Archon node). Run:  npm run e2e:forge-present
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  Sensitivity,
  PROTOCOL_VERSION,
  FileSpentTxnStore,
  type EvidenceRequest,
} from '@hearthold/core';
import { EvidenceService } from '@hearthold/warden/evidence';
import { VaultStore, type Artefact } from '@hearthold/warden/store';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const warden = await openKeymaster('warden', config, 'hearthold-e2e-forge');
  const wid = await ensureIdentity(warden, config);
  const store = new VaultStore(warden.dataFolder);

  // Seed a couple of LOW, witnessed `location` observations (a lunch trail — UC1 shape).
  for (const [i, day] of ['2026-07-07', '2026-07-08'].entries()) {
    const a: Artefact = {
      id: `loc-${i}`,
      kind: 'location',
      observedAt: `${day}T12:30:00Z`,
      storedAt: new Date().toISOString(),
      sensitivity: Sensitivity.LOW,
      ciphertext: '(sealed)',
      metadata: { witness: wid.did },
    };
    await store.put(a);
  }

  const evidence = new EvidenceService(warden, { ...config, sovereignDid: wid.did }); // no approver: LOW needs none
  const forge = (claim: string, kind: string, from?: string, to?: string) => {
    const req: EvidenceRequest = {
      type: 'hearthold/evidence-request',
      version: PROTOCOL_VERSION,
      claim,
      disclosureMode: 'ATTESTATION',
      spec: { kind: kind as never, from, to },
      subjectDid: wid.did,
      validForMinutes: 10,
    };
    return evidence.handle(req, wid.did, true);
  };

  process.stdout.write('▸ Forge a scroll from witnessed location data (LOW → no step-up)\n');
  const r = await forge('Went out for lunch on 2026-07-07..08', 'location', '2026-07-01', '2026-07-31');
  assert(r.status === 'granted', 'the forge is granted (witnessed data clears at STANDING)');
  if (r.status !== 'granted' || !r.credentialDid) throw new Error('no credentialDid');
  const scroll = r.credentialDid;
  assert(scroll.startsWith('did:'), 'the minted scroll is a real credential DID');
  assert(!!r.graph?.validUntil, 'the scroll carries an ephemeral validUntil');

  // /api/present logic: single-use, verifier-side, keyed by credentialDid.
  const spent = new FileSpentTxnStore(warden.dataFolder);
  const present = async (credentialDid: string): Promise<{ verified: boolean; reason?: string }> => {
    if (await spent.isSpent(credentialDid)) return { verified: false, reason: 'single-use scroll already spent (burned)' };
    await spent.markSpent(credentialDid);
    return { verified: true };
  };

  process.stdout.write('\n▸ Present the scroll — it verifies, then burns\n');
  const first = await present(scroll);
  assert(first.verified, 'the scroll verifies the first time it is played');
  const second = await present(scroll);
  assert(!second.verified && /spent|burn/i.test(second.reason ?? ''), 'a second presentation is refused — the scroll burned');

  process.stdout.write('\n▸ A forge with no supporting artefacts is denied (not thrown)\n');
  const empty = await forge('Climbed Everest yesterday', 'activity');
  assert(empty.status === 'denied', 'no matching artefacts → denied (a first-class outcome)');

  process.stdout.write('\n✓ Forge → present → burn: mint from witnessed data, present once, second play refused\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-forge-present: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
