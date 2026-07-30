/**
 * e2e: INGESTION GATE — quarantine-by-default + inert-until-confirmed + autofile trust (Sevenfold).
 *
 * Delegation authorizes an Emissary to PROPOSE, not to ADMIT. A submission is stored but NOT recall-indexed
 * (born-obsidian) unless it clears the quarantine policy; the Sovereign's triage-confirm is the admission
 * gesture that indexes it. A per-Emissary `autofile` trust-registry grant bypasses the quarantine floor.
 *
 *   A (unit, stub classifier+embedder): the mustConfirm matrix + inert-until-confirmed indexing.
 *   B (live): the autofile trust registry — grant → authorized(autofile); non-member → not.
 *   C (source-scan): config default SEALED; the handler applies the policy; the confirm route indexes.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-ingestion-gate.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  sealForWarden,
  createRegistryGroup,
  grantAuthorization,
  GroupTrustRegistry,
  Sensitivity,
  PROTOCOL_VERSION,
  type WitnessSubmission,
} from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { IndexStore } from '@hearthold/warden/index-store';
import { VaultStore } from '@hearthold/warden/store';
import type { Classifier } from '@hearthold/warden/classifier';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

// A confident/uncertain classifier stub at a chosen sensitivity (no Ollama).
const stubClassifier = (sensitivity: Sensitivity, uncertain: boolean): Classifier => ({
  async classify() {
    return { sensitivity, metadata: {}, needsHumanConfirmation: uncertain };
  },
});
const stubEmbedder = { async embed(_t: string): Promise<number[]> { return [1, 0]; } };

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-ingestion-gate-e2e';
  const config = { ...base, dataRoot: `${base.dataRoot}-ingestion-gate` };
  const warden = await openKeymaster('warden', config, pass);
  const wid = await ensureIdentity(warden, config);

  const submit = async (svc: WardenService, tag: string, policy?: { autofileTrusted?: boolean; confirmAtOrBelow?: Sensitivity }) => {
    const ciphertext = await sealForWarden(warden, wid.did, JSON.stringify({ text: `note ${tag}` }));
    const submission: WitnessSubmission = { type: 'hearthold/witness-submission', version: PROTOCOL_VERSION, kind: 'document', observedAt: new Date('2026-07-30').toISOString(), ciphertext };
    return svc.handleSubmission(submission, wid.did, undefined, policy);
  };
  const store = new VaultStore(warden.dataFolder);
  const index = new IndexStore(warden.dataFolder);
  const quarantined = async (id: string): Promise<boolean> => ((await store.get(id))?.metadata?.needsHumanConfirmation === true);

  step('A · default (no policy) quarantines EVERY tier — incl. HIGH/SEALED (the auto-file gap), and does NOT index');
  {
    const svc = new WardenService(warden, stubClassifier(Sensitivity.SEALED, false), stubEmbedder);
    const r = await submit(svc, 'sealed-default');
    check('a confident SEALED submission is quarantined by default', await quarantined(r.artefactId));
    check('and is NOT recall-indexed (born-obsidian → inert)', (await index.has(r.artefactId)) === false);
    const svcHigh = new WardenService(warden, stubClassifier(Sensitivity.HIGH, false), stubEmbedder);
    const rh = await submit(svcHigh, 'high-default');
    check('a confident HIGH submission is ALSO quarantined by default (fixes the auto-file gap)', await quarantined(rh.artefactId));
  }

  step('B · inert-until-confirmed: the quarantined item becomes searchable only after triage-confirm indexes it');
  {
    const svc = new WardenService(warden, stubClassifier(Sensitivity.MEDIUM, false), stubEmbedder);
    const r = await submit(svc, 'inert');
    check('quarantined + not indexed at submit', (await quarantined(r.artefactId)) && !(await index.has(r.artefactId)));
    // Admission: confirm indexes it (mirrors the control-plane triage/confirm route calling indexArtefact).
    const artefact = await store.get(r.artefactId);
    await svc.indexArtefact(artefact!);
    check('after admission (indexArtefact), it IS in the recall index', await index.has(r.artefactId));
  }

  step('C · policy: autofile-trusted bypasses quarantine; lowering the floor auto-admits; uncertainty always quarantines');
  {
    const svc = new WardenService(warden, stubClassifier(Sensitivity.MEDIUM, false), stubEmbedder);
    const trusted = await submit(svc, 'autofile', { autofileTrusted: true });
    check('autofile-trusted → NOT quarantined + indexed immediately', !(await quarantined(trusted.artefactId)) && (await index.has(trusted.artefactId)));
    const lowered = await submit(svc, 'lowered', { confirmAtOrBelow: Sensitivity.LOW });
    check('floor lowered below the tier → auto-admitted (MEDIUM > LOW)', !(await quarantined(lowered.artefactId)));
    const uncertain = await submit(new WardenService(warden, stubClassifier(Sensitivity.MEDIUM, true), stubEmbedder), 'uncertain', { autofileTrusted: true });
    check('classifier-uncertain quarantines EVEN when autofile-trusted (fail-safe wins)', await quarantined(uncertain.artefactId));
  }

  step('D · the autofile trust registry (live): grant → authorized(autofile); non-member → not');
  {
    const emissary = await openKeymaster('emissary', config, pass);
    const other = await openKeymaster('verifier', config, pass);
    const eid = await ensureIdentity(emissary, config);
    const oid = await ensureIdentity(other, config);
    const group = await createRegistryGroup(warden, 'hearthold-autofile-test', config.registry);
    await grantAuthorization(warden, group, eid.did);
    const tr = new GroupTrustRegistry(warden, [{ action: 'autofile', resource: undefined, group }], wid.did);
    check('a granted Emissary is authorized for autofile', (await tr.authorize({ entity_id: eid.did, action: 'autofile' })).authorized === true);
    check('a non-member is NOT authorized (→ quarantine)', (await tr.authorize({ entity_id: oid.did, action: 'autofile' })).authorized === false);
  }

  step('E · source-scan — the wiring holds');
  const root = dirname(fileURLToPath(import.meta.url));
  const cfg = readFileSync(join(root, '..', 'packages/core/src/config.ts'), 'utf8');
  const handler = readFileSync(join(root, '..', 'packages/warden/src/handler.ts'), 'utf8');
  const control = readFileSync(join(root, '..', 'packages/warden/src/control.ts'), 'utf8');
  check('config defaults confirmAtOrBelow to SEALED (quarantine-all)', /confirmAtOrBelow: parseSensitivity\(env\.HEARTHOLD_CONFIRM_AT_OR_BELOW, Sensitivity\.SEALED\)/.test(cfg));
  check('the submission handler applies the autofile check + threshold', /isAutofileTrusted\(fromDid\)/.test(handler) && /autofileTrusted/.test(handler));
  check('the control plane passes the ingest policy (confirmAtOrBelow + isAutofileTrusted)', /confirmAtOrBelow: config\.confirmAtOrBelow/.test(control) && /isAutofileTrusted,/.test(control));
  check('the triage/confirm route indexes on admission', /await service\.indexArtefact\(confirmed\)/.test(control));

  process.stdout.write(
    failures === 0
      ? '\n✓ ingestion-gate: quarantine-by-default (incl HIGH/SEALED), inert-until-confirmed, autofile-trust bypass, uncertainty fail-safe\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-ingestion-gate: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
