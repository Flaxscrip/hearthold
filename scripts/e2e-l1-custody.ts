/**
 * e2e: L1 KEY CUSTODY (per-role passphrase, reload-before-write, rotation CLI).
 *
 *   Part A (pure, no node): `passphraseFor(role)` precedence — per-role HEARTHOLD_PASSPHRASE_<ROLE> wins,
 *     else the shared HEARTHOLD_PASSPHRASE, else it throws (fail-closed). This is L1-1: a leak of one role's
 *     passphrase no longer decrypts every agent's wallet.
 *   Part B (live node): the incident-response primitives on a throwaway wallet — `reloadWallet` (the
 *     reload-before-write core, L1-2), and `runKeyMaintenance` rotate / check / passphrase (L1-4). Proves a
 *     passphrase change re-encrypts AT REST: the new passphrase opens the wallet, the old one is refused.
 *
 *   HEARTHOLD_PASSPHRASE=… node --experimental-strip-types scripts/e2e-l1-custody.ts
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  openKeymaster,
  openKeymasterFresh,
  passphraseFor,
  reloadWallet,
  runKeyMaintenance,
  ensureIdentity,
  type CipherPrivateJwk,
} from '@hearthold/core';
import { SessionKeyStore } from '@hearthold/warden/session-keys';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  step('L1-1: passphraseFor precedence (pure)');
  const save = { shared: process.env.HEARTHOLD_PASSPHRASE, role: process.env.HEARTHOLD_PASSPHRASE_WARDEN };
  try {
    process.env.HEARTHOLD_PASSPHRASE = 'shared-pass';
    process.env.HEARTHOLD_PASSPHRASE_WARDEN = 'warden-pass';
    check('per-role HEARTHOLD_PASSPHRASE_WARDEN wins over shared', passphraseFor('warden') === 'warden-pass');
    check('a role with no per-role override falls back to shared', passphraseFor('emissary') === 'shared-pass');
    delete process.env.HEARTHOLD_PASSPHRASE_WARDEN;
    check('warden falls back to shared once its override is gone', passphraseFor('warden') === 'shared-pass');
    delete process.env.HEARTHOLD_PASSPHRASE;
    let threw = false;
    try {
      passphraseFor('warden');
    } catch {
      threw = true;
    }
    check('no passphrase at all → throws (fail-closed)', threw);
  } finally {
    if (save.shared === undefined) delete process.env.HEARTHOLD_PASSPHRASE;
    else process.env.HEARTHOLD_PASSPHRASE = save.shared;
    if (save.role === undefined) delete process.env.HEARTHOLD_PASSPHRASE_WARDEN;
    else process.env.HEARTHOLD_PASSPHRASE_WARDEN = save.role;
  }

  step('L1-5: SessionKeyStore.zeroize really wipes the secret (Buffer-backed, not string-scrub)');
  {
    const store = new SessionKeyStore();
    const secret = 'SECRETSCALARdddddddddddddddddddddddddddddddd';
    const priv = { kty: 'EC', crv: 'secp256k1', x: 'PUBX', y: 'PUBY', d: secret } as unknown as CipherPrivateJwk;
    store.put('tok', 'part', priv);
    const round = store.get('tok', 'part') as unknown as { d: string; kty: string } | undefined;
    check('get() round-trips the JWK (secret + public fields)', round?.d === secret && round?.kty === 'EC');
    // Reach into the private store to grab the ACTUAL held Buffer, and prove it (a) holds the secret bytes
    // now and (b) is overwritten in place by zeroize — the property a string-scrub could never give.
    const held = (store as unknown as { keys: Map<string, Map<string, { d: Buffer }>> }).keys.get('tok')!.get('part')!;
    check('the session-resident secret is held in a Buffer containing the key bytes', held.d.toString('utf8') === secret);
    const n = store.zeroize('tok');
    check('zeroize reports the key count', n === 1);
    check('the held Buffer is now all-zero (real wipe, in place)', held.d.every((b) => b === 0));
    check('get() after zeroize returns undefined', store.get('tok', 'part') === undefined && store.count('tok') === 0);
  }

  step('L1 wiring (source scan): every agent uses passphraseFor + maintenance; the daemon guards writes');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
  for (const role of ['warden', 'sovereign', 'emissary', 'verifier', 'registry']) {
    const idx = src(`packages/${role}/src/index.ts`);
    check(`${role} resolves its passphrase via passphraseFor('${role}')`, new RegExp(`passphraseFor\\('${role}'\\)`).test(idx));
    check(`${role} no longer reads process.env.HEARTHOLD_PASSPHRASE directly`, !/process\.env\.HEARTHOLD_PASSPHRASE\b/.test(idx));
    check(`${role} exposes rotate + passphrase maintenance`, /case 'rotate'/.test(idx) && /case 'passphrase'/.test(idx) && /runKeyMaintenance\(handle/.test(idx));
  }
  const control = src('packages/warden/src/control.ts');
  check('control daemon defines the reload-before-write guard (withWalletWrite → reloadWallet)', /const withWalletWrite =/.test(control) && /await reloadWallet\(handle\)/.test(control));
  for (const mut of ['issueDelegation(handle', 'claimMark(handle', 'evidenceService.handle(', 'grantAuthorization(handle', 'revokeAuthorization(handle']) {
    // Proximity test: a `withWalletWrite(` must open within ~140 chars before the mutation call, i.e. the
    // mutation actually sits inside the guard (not merely co-present in the file).
    const at = control.indexOf(mut);
    const wrapped = at > 0 && control.lastIndexOf('withWalletWrite(', at) > at - 140;
    check(`wallet mutation "${mut.split('(')[0]}" is wrapped in withWalletWrite`, wrapped);
  }

  step('L1-2 + L1-4: reload-before-write + rotate / check / passphrase on a throwaway wallet (live)');
  const dataRoot = mkdtempSync(join(tmpdir(), 'hearthold-l1-'));
  const oldPass = 'l1-old-passphrase';
  const newPass = 'l1-new-passphrase';
  try {
    const config = { ...loadConfig(), dataRoot } as ReturnType<typeof loadConfig>;
    const handle = await openKeymaster('warden', config, oldPass);
    const id = await ensureIdentity(handle, config);
    check('provisioned a throwaway Warden identity', id.did.startsWith('did:'));

    // reloadWallet: the reload-before-write core — re-reads the on-disk wallet into the live handle.
    await reloadWallet(handle);
    check('reloadWallet re-reads the wallet without throwing', true);

    // rotate: signing keys move forward; the DID keeps resolving.
    const rot = await runKeyMaintenance(handle, 'rotate');
    check('rotate reports success', /rotated/.test(rot));
    check('the identity still resolves after a rotation', (await handle.keymaster.resolveDID(id.did).then(() => true, () => false)));

    // check: wallet health.
    const chk = await runKeyMaintenance(handle, 'check', undefined);
    check('check returns a wallet report', /wallet check:/.test(chk));

    // passphrase: re-encrypt at rest. New passphrase opens; old is refused.
    const pw = await runKeyMaintenance(handle, 'passphrase', newPass);
    check('passphrase change reports re-encryption', /re-encrypted/.test(pw));
    const openedNew = await openKeymasterFresh('warden', config, newPass).then(() => true, () => false);
    check('the NEW passphrase opens the wallet at rest', openedNew);
    const openedOld = await openKeymasterFresh('warden', config, oldPass).then(() => true, () => false);
    check('the OLD passphrase is REFUSED after the change', !openedOld);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ L1-custody: per-role passphrase precedence, reload-before-write, rotate/check/passphrase all hold\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-l1-custody: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
