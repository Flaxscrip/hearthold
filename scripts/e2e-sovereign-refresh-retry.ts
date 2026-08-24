/**
 * e2e: the reload's torn-read retry (node-free).
 *
 * `openKeymasterFresh` re-reads wallet.json and, because keymaster's `saveWallet` is non-atomic
 * (`writeFileSync`, no temp-rename), retries a torn read that races a concurrent write — failing CLOSED
 * if the file never becomes readable. This is pure local-file behavior (create wallet, corrupt file,
 * restore, reload), so it needs NO Archon node and runs even when the gatekeeper is down.
 *
 *   node --experimental-strip-types scripts/e2e-sovereign-refresh-retry.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, openKeymaster, openKeymasterFresh, agentDataFolder } from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-refresh-retry';
  const walletPath = join(agentDataFolder(config, 'sovereign'), 'wallet.json');

  step('Create a valid wallet.json (local bip39 seed — no gatekeeper)');
  const seed = await openKeymaster('sovereign', config, pass);
  await seed.keymaster.newWallet(undefined, true); // generates + persists a valid, decryptable wallet
  const goodBytes = readFileSync(walletPath, 'utf-8');
  check('valid wallet written to disk', goodBytes.length > 0);

  step('Corrupt the wallet file (simulate a torn mid-write read)');
  writeFileSync(walletPath, '{"version":2,"seed":{"mnemonicEnc":"trunca'); // partial JSON
  let baselineThrew = false;
  try {
    const h = await openKeymaster('sovereign', config, pass);
    await h.keymaster.loadWallet();
  } catch {
    baselineThrew = true;
  }
  check('a plain reload (no retry) FAILS on the torn file — the edge is real', baselineThrew);

  step('Restore the valid bytes shortly after — openKeymasterFresh must retry through the torn window');
  // The writer "finishes" after ~180ms; the reload started before that must retry, not give up.
  const restore = setTimeout(() => writeFileSync(walletPath, goodBytes), 180);
  let recovered = false;
  try {
    await openKeymasterFresh('sovereign', config, pass, { retries: 8, backoffMs: 60 });
    recovered = true;
  } catch {
    recovered = false;
  }
  clearTimeout(restore);
  check('openKeymasterFresh RECOVERED after the file became readable (retry works)', recovered);

  step('When the file never recovers, it fails CLOSED (throws, no silent success)');
  writeFileSync(walletPath, '{"version":2,"seed":{"mnemonicEnc":"still-bad'); // stays corrupt
  let failedClosed = false;
  try {
    await openKeymasterFresh('sovereign', config, pass, { retries: 3, backoffMs: 20 });
  } catch {
    failedClosed = true;
  }
  check('a permanently-torn file makes the reload throw (fail closed, no disclosure)', failedClosed);

  // Leave a valid wallet behind (tidy, though the data root is disposable).
  writeFileSync(walletPath, goodBytes);

  process.stdout.write(failures === 0 ? '\n✓ torn-read retry: recovers on a transient race, fails closed on a persistent one\n' : `\n✗ ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-sovereign-refresh-retry: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
