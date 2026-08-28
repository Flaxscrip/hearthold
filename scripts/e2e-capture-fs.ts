/**
 * e2e: capture:fs — the filesystem-crawler Emissary module, end to end over real DIDComm.
 *
 * Proves the demo arc: a crawler (holding a Warden delegation) walks a directory and, per text file, submits
 * a DERIVED summary + metadata + sha256 — never the body bytes — to the Warden, which classifies on-device
 * and quarantines it born-obsidian. Asserts:
 *   1. only handled files (text/md/code) are submitted; binaries + noise dirs (node_modules) are skipped;
 *   2. each submission gets a receipt with an artefactId;
 *   3. the vault holds them, SEALED + quarantined (deny-by-default);
 *   4. THE PRIVACY INVARIANT — decrypting a stored entry as the Warden shows the file's HEADING but NOT its
 *      secret body token: the content stayed on disk, only the derived summary was submitted;
 *   5. --dry-run summarizes but submits nothing.
 *
 * Quarantine classifier → no live model needed. Run:  npm run e2e:capture-fs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  acceptDelegation,
  requestProof,
  presentProof,
  unsealAsWarden,
  DidCommTransport,
  IDENTITY_NAME,
  Sensitivity,
  type KeymasterHandle,
} from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { DelegationStore } from '@hearthold/warden/delegations';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { QuarantineClassifier } from '@hearthold/warden/classifier';
import { crawlDirectory, type CrawlDeps } from '@hearthold/emissary/modules/capture-fs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e-capture-fs');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';
const BODY_SECRET = 'SECRET_BODY_TOKEN_do_not_leak_42';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

/** Build a fixture tree: 3 handled files (md/ts/txt), 1 binary (skip), and a node_modules dir (never descend). */
async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'capture-fs-'));
  await writeFile(join(root, 'roadmap.md'), `# Project Roadmap\n\n${BODY_SECRET} in the body.\n\n## Deployment\n\nmore body ${BODY_SECRET}\n`);
  await writeFile(join(root, 'thing.ts'), `export function computeThing(x) {\n  const ${BODY_SECRET} = x;\n  return ${BODY_SECRET};\n}\n`);
  await writeFile(join(root, 'notes.txt'), `plain notes with ${BODY_SECRET} inside\nsecond line\n`);
  await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // PNG magic — unhandled ext
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), `module.exports = "${BODY_SECRET}";\n`); // must be skipped
  return root;
}

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(`Hearthold capture:fs e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Open agents + delegate the "document" kind to the crawler');
  const warden: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const crawler: KeymasterHandle = await openKeymaster('emissary', config, PASSPHRASE);
  const wardenId = await ensureIdentity(warden, config);
  const crawlerId = await ensureIdentity(crawler, config);
  const schemaDid = await ensureDelegationSchema(warden);
  const delegationDid = await issueDelegation(warden, crawlerId.did, schemaDid, {
    kinds: ['document'],
    validUntil: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
  });
  await acceptDelegation(crawler, delegationDid);
  check('crawler ready + holds a "document" delegation', delegationDid.startsWith('did:'));

  step('Warden serves (quarantine classifier — everything born-obsidian SEALED)');
  const svc = new WardenService(warden, new QuarantineClassifier());
  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, config.nodeUrl);
  await wardenTransport.ready();
  const stop = await wardenTransport.serve(makeWardenHandler(svc, new DelegationStore(warden)), { pollMs: 1000 });

  const fixture = await makeFixture();
  try {
    const crawlerTransport = new DidCommTransport(crawler, IDENTITY_NAME.emissary, config.nodeUrl);
    await crawlerTransport.ready();
    const deps: CrawlDeps = {
      handle: crawler,
      wardenDid: wardenId.did,
      transport: crawlerTransport,
      // The crawler presents its delegation per submission: request a challenge, sign it.
      presentDelegation: async () => presentProof(crawler, await requestProof(warden, { schema: schemaDid, trustedIssuers: [wardenId.did] })),
    };

    step('Dry-run: summarize, submit nothing');
    const dry = await crawlDirectory(deps, { root: fixture, dryRun: true });
    check('dry-run submitted nothing', dry.submitted === 0);
    check('dry-run still summarized the 3 handled files', dry.files.filter((f) => f.summary).length === 3);

    step('Crawl for real');
    const report = await crawlDirectory(deps, { root: fixture });
    check('submitted exactly the 3 handled files (md, ts, txt)', report.submitted === 3);
    check('the binary .png was skipped (unhandled extension)', report.files.some((f) => f.relPath === 'logo.png' && /unhandled extension/.test(f.skipped ?? '')));
    check('node_modules was never descended', !report.files.some((f) => f.relPath.includes('node_modules')));
    check('every submitted file carries a sha256 + artefactId', report.files.filter((f) => f.artefactId).every((f) => !!f.sha256));

    step('Vault holds the entries, quarantined SEALED');
    const artefactIds = report.files.map((f) => f.artefactId).filter((x): x is string => !!x);
    let stored: Awaited<ReturnType<typeof svc.listArtefacts>> = [];
    for (let i = 0; i < 60 && stored.length < 3; i++) {
      stored = (await svc.listArtefacts()).filter((a) => artefactIds.includes(a.id));
      if (stored.length < 3) await new Promise((r) => setTimeout(r, 200));
    }
    check('all 3 landed in the vault (background store completed)', stored.length === 3);
    check('all quarantined SEALED (deny-by-default)', stored.every((a) => a.sensitivity === Sensitivity.SEALED));

    step('PRIVACY INVARIANT: the vault entry holds the summary, NOT the body');
    const md = report.files.find((f) => f.relPath === 'roadmap.md');
    const mdArtefact = stored.find((a) => a.id === md?.artefactId);
    check('found the roadmap.md vault entry', !!mdArtefact);
    if (mdArtefact) {
      const plain = await unsealAsWarden(warden, mdArtefact.ciphertext);
      check('the entry contains the derived heading ("Roadmap")', plain.includes('Roadmap'));
      check('the entry does NOT contain the secret body token — content never left the disk', !plain.includes(BODY_SECRET));
    }
  } finally {
    stop();
    await rm(fixture, { recursive: true, force: true });
  }

  process.stdout.write(failures === 0 ? '\nPASS\n' : `\nFAIL (${failures})\n`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
