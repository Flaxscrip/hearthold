/**
 * e2e: L2 DISCLOSURE-HARDENING (regression guard for the 2026-07-27 cleanup batch). A pure source scan —
 * nothing to stand up — asserting each fix stays wired so a refactor can't silently reopen the leak:
 *
 *   L2-3  snapshot delegations are owner-scoped (a delegation carries `memberDid`; the snapshot filters by
 *         the viewer and the delegate route attributes the delegation to the delegator).
 *   L2-4  triage/confirm co-signs a DOWNGRADE (relaxing an artefact's classification is a declassification).
 *   L2-5  a guardian-read scope/ceiling denial collapses to a uniform 'not available' and never echoes the
 *         artefact's real kind/sensitivity.
 *   L2-7  credential ingest fail-safes to DEFAULT_SENSITIVITY (SEALED), not MEDIUM.
 *   L2-8  marks are owner-scoped to the claimant's visible set and marks/claimable is session-gated.
 *
 *   node --experimental-strip-types scripts/e2e-l2-hardening.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const control = read('packages/warden/src/control.ts');
const delegations = read('packages/warden/src/delegations.ts');
const ruleset = read('packages/core/src/ruleset.ts');
const guardianship = read('packages/warden/src/guardianship.ts');
const credentialVault = read('packages/warden/src/credential-vault.ts');
const marks = read('packages/warden/src/marks.ts');

// Slice control.ts into per-route blocks so a check sees only that handler's body.
const routeMarks: { key: string; idx: number }[] = [];
const routeRe = /'((?:GET|POST|PUT|DELETE) \/api\/[a-z/-]+)':/g;
for (let m = routeRe.exec(control); m; m = routeRe.exec(control)) routeMarks.push({ key: m[1]!, idx: m.index });
const blockOf = (key: string): string => {
  const i = routeMarks.findIndex((x) => x.key === key);
  return i < 0 ? '' : control.slice(routeMarks[i]!.idx, routeMarks[i + 1]?.idx ?? control.length);
};

async function main(): Promise<void> {
  step('L2-3: snapshot delegations are owner-scoped');
  check('DelegationStore.list surfaces memberDid (so callers can owner-scope)', /memberDid: r\.memberDid/.test(delegations));
  check('snapshot filters delegations by viewer (delegationsFor)', /delegations: await delegationsFor\(viewer\)/.test(control));
  check('delegationsFor scopes by memberDid ?? sovereign', /\.filter\(\(d\) => \(d\.memberDid \?\? config\.sovereignDid\) === viewer\)/.test(control));
  check('the delegate route attributes the delegation to the delegator (actor)', /delegations\.record\(emissaryDid, credentialDid, actor\)/.test(blockOf('POST /api/delegate')));

  step('L2-4: triage/confirm co-signs a downgrade (declassification)');
  const triage = blockOf('POST /api/triage/confirm');
  check('triage/confirm is session-gated (effectiveViewer)', /effectiveViewer\(ctx\)/.test(triage));
  check('triage/confirm co-signs when lowering sensitivity', /requested < target\.sensitivity/.test(triage) && /coSign\(viewer, 'triage-relax'/.test(triage));

  step("L2-5: a guardian scope/ceiling denial is a uniform 'not available' (no attribute leak)");
  // Scope the echo check to authorizeGuardianRead only — authorizeActor legitimately echoes the CALLER's
  // own requested kind/sensitivity (no new info), whereas guardianRead would be leaking the ARTEFACT's.
  const gStart = ruleset.indexOf('export async function authorizeGuardianRead');
  const gBody = ruleset.slice(gStart, ruleset.indexOf('export async function', gStart + 1));
  check('authorizeGuardianRead tags scope/ceiling denials with code:scope', /code: 'scope'/.test(gBody));
  check('scope/ceiling reasons no longer echo req.kind / req.sensitivity', !/\$\{req\.kind\}/.test(gBody) && !/\$\{req\.sensitivity\}/.test(gBody));
  check("guardianRead collapses a scope denial to 'not available'", /authz\.code === 'scope' \? 'not available'/.test(guardianship));

  step('L2-7: credential ingest fail-safes to DEFAULT_SENSITIVITY (SEALED)');
  check('ingest default is DEFAULT_SENSITIVITY, not Sensitivity.MEDIUM', /args\.sensitivity \?\? DEFAULT_SENSITIVITY/.test(credentialVault) && !/args\.sensitivity \?\? Sensitivity\.MEDIUM/.test(credentialVault));

  step('L2-8: marks are owner-scoped and marks/claimable is session-gated');
  check('countFor filters to the owner’s visible set', /\(a\.owner \?\? sovereignDid\) === owner \|\| a\.scope === 'shared'/.test(marks));
  check('claimMark re-counts over the claimant (subjectDid) only', /countFor\(warden, candidate\.spec, subjectDid, sovereignDid\)/.test(marks));
  const claimable = blockOf('POST /api/marks/claimable');
  check('marks/claimable is session-gated + owner-scoped', /effectiveViewer\(ctx\)/.test(claimable) && /claimableMarks\(handle, candidates \?\? \[\], viewer/.test(claimable));

  process.stdout.write(
    failures === 0
      ? '\n✓ L2-hardening: delegations/marks owner-scoped, triage downgrade co-signs, guardian denial uniform, ingest fail-safe SEALED\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-l2-hardening: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
