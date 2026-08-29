/**
 * Build the private "agency" KB — David's Architecture of Agency corpus, ingested with the Book Worm and
 * gated behind Hearthold's normal challenge/response wall. Members (the owner + David) query it with their
 * own wallet; nobody else can. This is the PRIVATE-book payoff: an author's manuscript, answerable to
 * authorized readers, the text never leaving the custodian.
 *
 * Sets up a member-gated KB (read/write groups + a signed assurance policy — NO anonymous oracle reader),
 * grants the owner + David read membership, then ingests the whole corpus into the KB (sealed, PUBLIC
 * sensitivity, kb-tagged — the book isn't secret, but query ACCESS is member-gated). Finally verifies a
 * real member query end to end.
 *
 * Run it where the KB Warden's data lives (locally for a private dry run; on the deploy host for the live KB).
 *   HEARTHOLD_PASSPHRASE=… npm run build:agency-kb                 # full corpus, kbId "agency"
 *   HEARTHOLD_PASSPHRASE=… npm run build:agency-kb -- agency 2 3   # dry run: 2 volumes × 3 chapters
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  sealForWarden,
  contentId,
  signKbRequest,
  createRegistryGroup,
  grantAuthorization,
  selfSigner,
  Sensitivity,
  type KeymasterHandle,
  type KbRequestStatement,
} from '@hearthold/core';
import { KbConfigStore, initKbAssurance, buildKbServices } from '@hearthold/warden/kb-config';
import { VaultStore, type Artefact } from '@hearthold/warden/store';
import { IndexStore } from '@hearthold/warden/index-store';
import { OllamaEmbedder } from '@hearthold/warden/recall';
import { ingestCorpus, type BookChunk, type BookWormDeps } from '@hearthold/emissary/modules/bookworm';

const CORPUS_URL = 'https://axionic.org/book/index.html';
// David's identity to grant read to. A NAME (name@domain) needs wider-network name resolution — a SEALED
// node can't do that, so pass his raw did:cid via AGENCY_DAVID there. resolveDID takes either form unchanged.
const DAVID_NAME = process.env.AGENCY_DAVID ?? 'cypher@4tress.org';
const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.HEARTHOLD_DATA_ROOT ?? join(here, '..', '.hearthold-agency-kb');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-agency-kb';
const say = (m = ''): void => process.stdout.write(`${m}\n`);
const rule = (): void => say('─'.repeat(78));

async function main(): Promise<void> {
  const kbId = process.argv[2] ?? 'agency';
  const maxVolumes = process.argv[3] ? Number(process.argv[3]) : Infinity;
  const maxChaptersPerVolume = process.argv[4] ? Number(process.argv[4]) : Infinity;
  // A book corpus is a deep-synthesis KB → default to a REASONING answer model so the verify query (and a
  // served warden with the same model) thinks. Override with HEARTHOLD_ANSWER_MODEL.
  const config = { ...loadConfig(), dataRoot: DATA_ROOT, answerModel: process.env.HEARTHOLD_ANSWER_MODEL ?? 'qwen3:8b' };

  rule();
  say(`  📖 Building the private "${kbId}" KB — David's corpus, behind challenge/response`);
  rule();
  say(`  corpus: ${CORPUS_URL}`);
  say(`  data:   ${DATA_ROOT}`);
  say(`  model:  ${config.ollamaUrl} (embed=${config.embeddingModel}, answer=${config.answerModel})`);

  const warden: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE);
  const owner: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE); // the KB owner + a member (for verify)
  const wid = await ensureIdentity(warden, config);
  const ownerId = await ensureIdentity(owner, config);

  say('\n▶ 1. RESOLVE members');
  const davidDid = await warden.keymaster.resolveDID(DAVID_NAME).then((d) => (typeof d === 'string' ? d : (d as { didDocument?: { id?: string } })?.didDocument?.id));
  if (!davidDid) throw new Error(`could not resolve David (${DAVID_NAME})`);
  say(`   owner: ${ownerId.did}`);
  say(`   David: ${DAVID_NAME} → ${davidDid}`);

  say(`\n▶ 2. CREATE the member-gated KB "${kbId}" (read/write groups + signed assurance; no anonymous reader)`);
  const kbStore = new KbConfigStore(warden.dataFolder);
  const existing = await kbStore.get(kbId).catch(() => undefined);
  let readGroup: string;
  if (existing) {
    readGroup = existing.readGroup;
    say(`   KB already configured — reusing (readGroup ${readGroup.slice(0, 20)}…)`);
  } else {
    readGroup = await createRegistryGroup(warden, `kb-read-${kbId}`, config.registry);
    const writeGroup = await createRegistryGroup(warden, `kb-write-${kbId}`, config.registry);
    const policyAsset = await initKbAssurance(warden, config, kbId, selfSigner(warden, wid.did));
    // answerThink: a book corpus is a deep-synthesis KB — recall reasons over the retrieved passages.
    await kbStore.put({ kbId, readGroup, writeGroup, policyAsset, governorDid: undefined, answerThink: true });
    say(`   created — read ${readGroup.slice(0, 20)}… · write ${writeGroup.slice(0, 20)}…`);
  }
  await grantAuthorization(warden, readGroup, ownerId.did); // owner can query (and verify below)
  await grantAuthorization(warden, readGroup, davidDid); // David can query with his own wallet
  say(`   granted READ to the owner and to David (${DAVID_NAME}).`);

  say('\n▶ 3. INGEST the corpus into the KB (Book Worm) — fetch+chunk, then parallel-embed + bulk-write');
  const store = new VaultStore(warden.dataFolder);
  const index = new IndexStore(warden.dataFolder);
  const embedder = new OllamaEmbedder(config.ollamaUrl, config.embeddingModel);
  const now = new Date().toISOString();

  // Phase A — fetch + chunk the whole corpus, COLLECTING passages (no embed/write yet: fast).
  const collected: BookChunk[] = [];
  const deps: BookWormDeps & { onVolume?: (u: string, ch: number, ck: number) => void } = {
    fetchText: async (url) => {
      const res = await fetch(url, { headers: { 'user-agent': 'Hearthold-BookWorm/0.1' } });
      if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
      return res.text();
    },
    sink: async (c) => { collected.push(c); },
    onVolume: (u, ch, ck) => say(`   ✓ ${u.replace(/.*\/book\//, '').replace(/\/index\.html$/, '')}  —  ${ch} chapter(s), ${ck} passage(s)`),
  };
  const report = await ingestCorpus(deps, { corpusUrl: CORPUS_URL, maxVolumes, maxChaptersPerVolume });
  for (const v of report.perVolume) if (v.error) say(`   – ${v.url} — ${v.error}`);

  // Phase B — embed the passages in parallel batches (embedding is read-only → safe to parallelize; the
  // slow network step, so concurrency is the win). Sealing is local crypto. Build artefacts + index entries.
  const CONCURRENCY = 8;
  const artefacts: Artefact[] = [];
  const entries: { artefactId: string; kind: 'book'; observedAt: string; sensitivity: number; embedding: number[]; kb: string }[] = [];
  say(`   embedding ${collected.length} passage(s) (${CONCURRENCY}-way)…`);
  for (let i = 0; i < collected.length; i += CONCURRENCY) {
    const batch = collected.slice(i, i + CONCURRENCY);
    const built = await Promise.all(
      batch.map(async (c) => {
        const payload = JSON.stringify({ text: c.text, metadata: { source: 'book', volume: c.volume, chapter: c.chapterTitle, section: c.section, url: c.url } });
        const ciphertext = await sealForWarden(warden, wid.did, payload);
        const id = contentId(ciphertext, warden.cipher);
        const artefact: Artefact = { id, kind: 'book', observedAt: now, storedAt: now, sensitivity: Sensitivity.PUBLIC, ciphertext, metadata: { kb: kbId, source: 'book', volume: c.volume, chapter: c.chapterTitle, section: c.section, url: c.url } };
        const embedding = await embedder.embed(c.text);
        return { artefact, entry: { artefactId: id, kind: 'book' as const, observedAt: now, sensitivity: Sensitivity.PUBLIC, embedding, kb: kbId } };
      }),
    );
    for (const b of built) { artefacts.push(b.artefact); entries.push(b.entry); }
  }

  // Phase C — bulk-write the vault + index ONCE (O(n), not O(n²) per-passage rewrites).
  await store.putMany(artefacts);
  await index.putMany(entries);
  say(`   indexed ${report.chunks} passage(s) across ${report.chapters} chapter(s) in ${report.volumes} volume(s).`);

  say('\n▶ 4. VERIFY a real member query (the owner signs a KB request — the challenge/response wall)');
  const kbs = await buildKbServices(warden, config, wid.did);
  const kb = kbs.get(kbId);
  if (!kb) throw new Error(`KbService for "${kbId}" not built`);
  const nonce = kb.challenge().nonce;
  const q = 'What does the corpus say about agency, alignment, and value?';
  const signed = await signKbRequest(owner, { action: 'query', requester: ownerId.did, kbId, nonce, query: q, k: 6 } as KbRequestStatement);
  const res = await kb.serve(signed);
  rule();
  if (res.type === 'hearthold/kb-result') {
    const r = res as { answer?: string; citations?: { artefactId: string; score: number }[] };
    say(`  Member query: "${q}"`);
    say(`  Answer:  ${r.answer ?? '(no answer)'}`);
    say(`  (${r.citations?.length ?? 0} citation(s))`);
  } else {
    say(`  member query returned: ${res.type} — ${(res as { reason?: string }).reason ?? ''}`);
  }
  rule();

  say(`\n  KB "${kbId}" is built and member-gated. David (${DAVID_NAME}) can query it with his own wallet;`);
  say('  a non-member is refused at the challenge. The manuscript never leaves the custodian. 📖');
  say(`\n  For deploy: point the kb-web Mage at this Warden (HEARTHOLD_WARDEN_DID=${wid.did}), kbId="${kbId}".`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
