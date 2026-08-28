/**
 * demo: capture:fs end to end — crawl → on-device classify → quarantine → admit → RECALL.
 *
 * The payoff walkthrough for the filesystem crawler. Point it at a folder; it derives an on-device summary
 * per file (never the body), submits to the Warden, which classifies + quarantines each born-obsidian; the
 * Sovereign admits them; then the Sovereign asks their vault a question and gets a machine-derived answer
 * with **content-hash provenance** — while the files never left the disk.
 *
 * Needs a live Archon node AND a live Ollama (classifier + embedding models). It is a WALKTHROUGH, not an
 * assertion — it narrates and prints, and degrades to a clear message if the model is unavailable.
 *
 *   HEARTHOLD_PASSPHRASE=… npm run demo:capture-fs                 # crawls a built-in fixture, default query
 *   HEARTHOLD_PASSPHRASE=… npm run demo:capture-fs -- ~/Notes "what are my deadlines?"   # your folder + query
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
  DidCommTransport,
  IDENTITY_NAME,
  Sensitivity,
  type KeymasterHandle,
} from '@hearthold/core';
import { WardenService } from '@hearthold/warden/service';
import { DelegationStore } from '@hearthold/warden/delegations';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { createClassifier } from '@hearthold/warden/classifier';
import { OllamaEmbedder, RecallService } from '@hearthold/warden/recall';
import { crawlDirectory, type CrawlDeps, type CrawlReport } from '@hearthold/emissary/modules/capture-fs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-demo-capture-fs');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-demo';
const SENS = ['PUBLIC', 'LOW', 'MEDIUM', 'HIGH', 'SEALED'];
const say = (m = ''): void => process.stdout.write(`${m}\n`);
const rule = (): void => say('─'.repeat(72));

/**
 * A tiny "7th Capital" data history — a few realistic files a person might have on disk. Kept SMALL (3
 * files) because each is classified by the local model, one at a time; a bigger set just makes the demo
 * slower without changing the story. Point the demo at your own folder for scale.
 */
async function builtinFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'demo-capture-fs-'));
  await writeFile(join(root, 'project-hearthold.md'), `# Hearthold plan\n\n## Deadlines\n\nShip the crawler demo by Friday. Review the security model with the team next week.\n\n## Open questions\n\nHow does recall scope sensitivity?\n`);
  await writeFile(join(root, 'trip-lisbon.md'), `# Lisbon trip\n\n## Itinerary\n\nFlight Friday morning, hotel in Alfama, dinner reservations Saturday.\n`);
  await writeFile(join(root, 'health-note.md'), `# Appointment\n\n## Results\n\nBlood pressure elevated; follow-up with the cardiologist scheduled. Prescription renewed.\n`);
  return root;
}

async function main(): Promise<void> {
  const argDir = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : undefined;
  const query = process.argv[3] ?? 'What deadlines or plans do my files mention?';
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };

  rule();
  say('  Hearthold · capture:fs — crawl → classify on-device → quarantine → admit → recall');
  rule();
  say(`  node:  ${config.nodeUrl}`);
  say(`  model: ${config.ollamaUrl} (classify=${config.classifierModel}, embed=${config.embeddingModel})`);
  say('  tip:   on-device classify runs one file at a time on your local model — for a snappier demo set');
  say('         HEARTHOLD_CLASSIFIER_MODEL to a small fast model, or point at a small folder.');

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

  // The REAL on-device pipeline: Ollama classifier + embedder (no quarantine shortcut — this is the demo).
  const embedder = config.indexMode === 'ollama' ? new OllamaEmbedder(config.ollamaUrl, config.embeddingModel) : undefined;
  const svc = new WardenService(warden, createClassifier(config), embedder);
  const wardenTransport = new DidCommTransport(warden, IDENTITY_NAME.warden, config.nodeUrl);
  await wardenTransport.ready();
  const stop = await wardenTransport.serve(makeWardenHandler(svc, new DelegationStore(warden)), { pollMs: 1000 });

  const dir = argDir ?? (await builtinFixture());
  const usingFixture = !argDir;

  try {
    const crawlerTransport = new DidCommTransport(crawler, IDENTITY_NAME.emissary, config.nodeUrl);
    await crawlerTransport.ready();
    const deps: CrawlDeps = {
      handle: crawler,
      wardenDid: wardenId.did,
      transport: crawlerTransport,
      presentDelegation: async () => presentProof(crawler, await requestProof(warden, { schema: schemaDid, trustedIssuers: [wardenId.did] })),
    };

    say();
    say(`▶ 1. CRAWL  ${dir}${usingFixture ? '  (built-in fixture)' : ''}`);
    say('   The crawler derives a summary on-device and submits it — the body bytes stay on disk.');
    const report: CrawlReport = await crawlDirectory(deps, { root: dir });
    for (const f of report.files) {
      if (f.artefactId) say(`     ✓ ${f.relPath}  —  ${f.summary}`);
      else say(`     – ${f.relPath}  (skipped: ${f.skipped})`);
    }
    say(`   Submitted ${report.submitted}/${report.scanned} files.`);

    say();
    say('▶ 2. CLASSIFY + QUARANTINE  (the Warden, on-device)');
    say('   Each artefact is classified by the LOCAL model and lands born-obsidian — this takes a moment');
    say('   per file (the cost of never sending content off-device). Nothing is recallable yet.');
    const ids = new Set(report.files.map((f) => f.artefactId).filter((x): x is string => !!x));
    let stored: Awaited<ReturnType<typeof svc.listArtefacts>> = [];
    // Wait for all to classify, but PROCEED once progress stalls (≥1 landed and nothing new for ~40s) so a
    // single slow/stuck file on a loaded local model doesn't leave the demo staring at dots. Hard cap 3 min.
    let lastCount = 0;
    let stalledPolls = 0;
    process.stdout.write('   classifying');
    for (let i = 0; i < 360 && stored.length < ids.size; i++) {
      stored = (await svc.listArtefacts()).filter((a) => ids.has(a.id));
      if (stored.length >= ids.size) break;
      stalledPolls = stored.length > lastCount ? 0 : stalledPolls + 1;
      lastCount = stored.length;
      if (stored.length >= 1 && stalledPolls >= 80) break; // ~40s with no new arrival
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 500));
    }
    say(stored.length < ids.size ? ` (${stored.length}/${ids.size} classified; the rest still processing — proceeding)` : ` (${stored.length}/${ids.size} classified)`);
    const relOf = (id: string): string => report.files.find((f) => f.artefactId === id)?.relPath ?? id.slice(0, 16);
    for (const a of stored) say(`     • ${relOf(a.id)}  →  ${SENS[a.sensitivity]}`);

    say();
    say('▶ 3. ADMIT  (the Sovereign confirms from triage)');
    say('   Admitting indexes each item for recall — the human is the gate, not the crawler.');
    for (const a of stored) await svc.indexArtefact(a);
    say(`     Admitted ${stored.length} item(s) into the recall index.`);

    say();
    say(`▶ 4. RECALL  "${query}"`);
    say('   Recall surfaces up to HIGH — SEALED items stay sealed (the sensitivity ceiling).');
    const recall = RecallService.forWarden(warden, config);
    const result = await recall.recall(query, { k: 5, maxSensitivity: Sensitivity.HIGH });
    say();
    rule();
    // The RETRIEVAL (which files, by similarity, with provenance) is the verifiable substance and always
    // available; the generated answer sentence is a best-effort flourish over a local model.
    if (result.citations.length) {
      say('  Retrieved these entries by similarity — the files stayed on disk; provenance is the hash:');
      for (const c of result.citations) {
        const f = report.files.find((x) => x.artefactId === c.artefactId);
        say(`    · ${f?.relPath ?? c.artefactId.slice(0, 16)}  ·  sha256:${(f?.sha256 ?? '').slice(0, 12)}…  ·  ${SENS[c.kind === 'image' ? 0 : stored.find((a) => a.id === c.artefactId)?.sensitivity ?? 0]}  ·  score ${c.score.toFixed(3)}`);
      }
      const answerFailed = /temporarily unavailable|couldn't retrieve|Nothing has been indexed/i.test(result.answer);
      say();
      if (answerFailed) say('  (On-device answer synthesis was slow — the retrieval + provenance above is the substance.)');
      else say(`  Synthesized answer:  ${result.answer}`);
    } else {
      say(`  ${result.answer}`);
    }
    rule();
    const sealed = stored.filter((a) => a.sensitivity === Sensitivity.SEALED).map((a) => relOf(a.id));
    if (sealed.length) {
      say();
      say(`  Note: ${sealed.join(', ')} classified SEALED — held back from this recall by the ceiling.`);
    }
    say();
    say('  The raw file contents never left the machine. The vault holds derived summaries keyed by');
    say('  content hash; recall answered from those, and every citation traces back to a file by its hash.');
  } finally {
    stop();
    if (usingFixture) await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
