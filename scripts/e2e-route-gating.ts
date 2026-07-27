/**
 * e2e: CONTROL-ROUTE GATING (L2-6 regression guard). Four mutating routes — delegate, kb/grant, kb/revoke,
 * kb/policy — were reachable UNAUTHENTICATED: they never called `effectiveViewer`, so `require-session` (which
 * only fires through `effectiveViewer`) didn't gate them, and `/api/delegate` minted a delegation for any
 * body-supplied DID. This asserts each is now wired to the session gate, and the authority-granting ones to a
 * Signet co-sign — so a route can't silently lose its gate again. (The behaviour — effectiveViewer → 401 — is
 * proven in e2e:require-session; this is the wiring guard, same shape as the B6 source scan.)
 *
 *   node --experimental-strip-types scripts/e2e-route-gating.ts   (source scan — nothing to stand up)
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

const control = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/warden/src/control.ts'), 'utf8');

// Slice the file into per-route blocks keyed by the route marker, so a check sees only that handler's body.
const marks: { key: string; idx: number }[] = [];
const routeRe = /'((?:GET|POST|PUT|DELETE) \/api\/[a-z/-]+)':/g;
for (let m = routeRe.exec(control); m; m = routeRe.exec(control)) marks.push({ key: m[1]!, idx: m.index });
const blockOf = (key: string): string => {
  const i = marks.findIndex((x) => x.key === key);
  if (i < 0) return '';
  return control.slice(marks[i]!.idx, marks[i + 1]?.idx ?? control.length);
};

async function main(): Promise<void> {
  step('The route slicer works (positive control: a known-gated route)');
  check("found the route table (>= 20 routes)", marks.length >= 20);
  check("GET /api/snapshot is session-gated (effectiveViewer)", /effectiveViewer\(/.test(blockOf('GET /api/snapshot')));

  step('L2-6: the previously-ungated routes now go through the session gate');
  for (const r of ['POST /api/delegate', 'POST /api/kb/grant', 'POST /api/kb/revoke', 'POST /api/kb/policy']) {
    const body = blockOf(r);
    check(`${r} is session-gated (effectiveViewer)`, /effectiveViewer\(ctx\)/.test(body) && !/async \(\{ body \}\)/.test(body));
  }

  step('The authority-granting / membership-changing routes require a Signet co-sign');
  for (const r of ['POST /api/delegate', 'POST /api/kb/grant', 'POST /api/kb/revoke']) {
    check(`${r} requires a co-sign`, /coSign\(/.test(blockOf(r)));
  }
  // kb/policy's human gate is its ruleset signer (governor) rather than a coSign call — assert that path holds.
  check('POST /api/kb/policy routes its policy signature through the governor/self signer', /makeDidcommRulesetSigner|selfSigner/.test(blockOf('POST /api/kb/policy')));

  process.stdout.write(
    failures === 0
      ? '\n✓ route-gating: delegate + kb/grant/revoke/policy are session-gated (require-session applies) and authority grants co-sign\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-route-gating: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
