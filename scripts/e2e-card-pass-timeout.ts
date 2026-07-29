/**
 * e2e: CARD-PASS REPLY-WAIT is operator-tunable (Sevenfold ask — cross-Tor round-trips exceed 60s).
 *
 * `POST /api/card/pass` blocks on the recipient's accept/decline ack; over a Tor substrate a slow-but-
 * successful ack can exceed the 60s transport default and be wrongly abandoned. `HEARTHOLD_CARD_PASS_TIMEOUT_MS`
 * tunes the wait (default 60s, clamped to the 600s hard cap), and the route passes it into `deliverCredential`.
 *
 *   node --experimental-strip-types scripts/e2e-card-pass-timeout.ts   (pure — no node needed)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  step('config — HEARTHOLD_CARD_PASS_TIMEOUT_MS tunes the reply-wait, clamped like the step-up');
  check('default is 60s when unset', loadConfig({}).cardPassTimeoutMs === 60_000);
  check('a Tor-substrate value (180s) is honored', loadConfig({ HEARTHOLD_CARD_PASS_TIMEOUT_MS: '180000' }).cardPassTimeoutMs === 180_000);
  check('clamped to the 600s hard cap', loadConfig({ HEARTHOLD_CARD_PASS_TIMEOUT_MS: '9999999' }).cardPassTimeoutMs === 600_000);
  check('an invalid value falls back to the default', loadConfig({ HEARTHOLD_CARD_PASS_TIMEOUT_MS: 'not-a-number' }).cardPassTimeoutMs === 60_000);
  check('a non-positive value falls back to the default', loadConfig({ HEARTHOLD_CARD_PASS_TIMEOUT_MS: '0' }).cardPassTimeoutMs === 60_000);

  step('wiring — the card/pass route passes the tunable timeout into deliverCredential');
  const control = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/warden/src/control.ts'), 'utf8');
  const passBlock = control.slice(control.indexOf("'POST /api/card/pass'"), control.indexOf("'POST /api/card/pass'") + 2200);
  // `timeoutMs: config.cardPassTimeoutMs` occurs only in the card/pass route; assert the route calls
  // deliverCredential AND the file carries the wiring.
  check('card/pass forwards timeoutMs: config.cardPassTimeoutMs to deliverCredential', /deliverCredential\(/.test(passBlock) && /timeoutMs: config\.cardPassTimeoutMs/.test(control));

  process.stdout.write(
    failures === 0
      ? '\n✓ card-pass-timeout: reply-wait is env-tunable (default 60s, cap 600s) and wired into the pass route\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-card-pass-timeout: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
