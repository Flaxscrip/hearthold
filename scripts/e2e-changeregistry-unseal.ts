/**
 * Proof for the agentic go-live: does `changeRegistry(warden, 'hyperswarm')` keep the sealed corpus readable?
 *
 * The login fix needs the agency Warden's identity moved local→hyperswarm (same DID, same keys, vault intact).
 * `unsealAsWarden` → `fetchKeyPair()` → `resolveDID(id.did, {confirm:true})` matches the wallet key against the
 * CONFIRMED DID doc — so if a registry move perturbed that, the corpus (David's gift) would go unreadable. The
 * signing key doesn't change under `changeRegistry`, so it SHOULD stay readable — but that's reasoning, and this
 * is the sealed gift. Prove it in a sandbox before touching the live Warden. Run on flaxlap (has hyperswarm):
 *   HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_PASSPHRASE=… node --experimental-strip-types scripts/e2e-changeregistry-unseal.ts
 *
 * ⚠️ CAVEAT (learned the hard way): this observes flaxlap's OWN view only. It proves the KEY survives a registry
 * relabel — it does NOT prove the move FEDERATES. A `local`-born DID's changeRegistry relabels the doc locally,
 * but the migration op queues on `local` and is dropped, so no other node ever learns of it (measured live
 * 2026-08-29: the moved Warden was `notFound` on public gatekeepers). "changeRegistry succeeded locally" ≠ "the
 * DID is public." Federation requires resolving the DID from a SECOND node — see INSTALL-agentic.md.
 */
import { loadConfig, openKeymaster, ensureIdentity, sealForWarden, unsealAsWarden, IDENTITY_NAME } from '@hearthold/core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function unsealAll(warden: Awaited<ReturnType<typeof openKeymaster>>, label: string, samples: [string, string][]): Promise<boolean> {
  let ok = true;
  for (const [plain, ct] of samples) {
    const out = await unsealAsWarden(warden, ct).catch((e: unknown) => `ERR:${e instanceof Error ? e.message : e}`);
    if (out !== plain) ok = false;
  }
  process.stdout.write(`  ${ok ? '✓' : '✗ FAIL'} ${label} — ${samples.length}/${samples.length} readable\n`);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE ?? 'changereg-test';
  const config = { ...base, registry: 'local', contentRegistry: 'local', ephemeralRegistry: 'local' };
  const warden = await openKeymaster('warden', config, pass);
  const wid = await ensureIdentity(warden, config);
  process.stdout.write(`Warden ${wid.did.slice(0, 28)}… born on 'local'\n`);

  // Seal a few artefacts to the Warden (as the corpus is sealed).
  const plaintexts = ['agency passage one — sealed to the Warden', 'passage two', 'a third sealed artefact, longer text to be sure'];
  const samples: [string, string][] = [];
  for (const p of plaintexts) samples.push([p, await sealForWarden(warden, wid.did, p)]);

  process.stdout.write('\n▸ 1. BASELINE — unseal while the Warden is on local\n');
  await unsealAll(warden, 'before changeRegistry', samples);

  process.stdout.write("\n▸ 2. changeRegistry(local → hyperswarm) — same DID + keys, registration only\n");
  const km = warden.keymaster as unknown as { changeRegistry(idName: string, registry: string): Promise<boolean> };
  const changed = await km.changeRegistry(IDENTITY_NAME.warden, 'hyperswarm').catch((e: unknown) => `ERR:${e instanceof Error ? e.message : e}`);
  process.stdout.write(`  changeRegistry returned: ${changed}\n`);
  await warden.gatekeeper.processEvents().catch(() => {});
  await warden.keymaster.loadWallet(); // re-read the wallet after the update

  process.stdout.write('\n▸ 3. PENDING — unseal immediately after the move (registration not yet confirmed)\n');
  await unsealAll(warden, 'after changeRegistry, pending', samples);

  process.stdout.write('\n▸ 4. Wait for the move to CONFIRM on hyperswarm, then unseal again\n');
  let reg: string | undefined;
  for (let i = 0; i < 40; i++) {
    await warden.gatekeeper.processEvents().catch(() => {});
    const doc = (await warden.keymaster.resolveDID(wid.did, { confirm: true }).catch(() => undefined)) as { didDocumentRegistration?: { registry?: string } } | undefined;
    reg = doc?.didDocumentRegistration?.registry;
    if (reg === 'hyperswarm') break;
    await sleep(3000);
  }
  process.stdout.write(`  confirmed registration after wait: ${reg ?? '(unresolved)'}\n`);
  await unsealAll(warden, `after changeRegistry, confirmed=${reg}`, samples);

  process.stdout.write(
    process.exitCode === 1
      ? '\n✗ changeRegistry BROKE unseal at some stage — do NOT run it on the live Warden.\n'
      : `\n✓ The corpus stays readable through changeRegistry (local → hyperswarm${reg === 'hyperswarm' ? ', confirmed' : ', confirm still pending'}). Safe for the live Warden.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`e2e-changeregistry-unseal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
