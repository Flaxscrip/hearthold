/**
 * e2e (Ollama integration, MANUAL — not in the CI gate): the anonymous oracle's RECALL half.
 *
 * The stub-transport e2e:oracle proves the portal CONTRACT (it sends scope:'shared', strips private
 * citations). This proves the two things that need a REAL model, which Aegis's GIN log cannot:
 *
 *   A. THINKING SUPPRESSION (PR #14) — the `think:false` our `noThink(model)` emits actually stops the
 *      hidden <think> pass on a reasoning model. Proven end-to-end on real Ollama: WITH the gate →
 *      message.thinking is empty; WITHOUT → it reasons. (Skipped, honestly, if the answer model is not a
 *      reasoning model — the field is a no-op there by design.)
 *
 *   B. SHARED-ONLY RECALL (a3e6df4) — the security property behind the public oracle: a query pinned to
 *      scope:'shared' must NOT surface a private artefact sitting in the reader's OWN partition, in the
 *      ANSWER or the citations — even though an un-pinned (union) query CAN reach it (proving the doc was
 *      really indexed, so exclusion is the scope, not a missing document). This is the belt-and-suspenders
 *      for the "the reader's private partition is empty by construction" dependency we removed.
 *
 * Needs a live Archon node + Ollama (embeddings + a reasoning answer model). Run:
 *   npm run e2e:oracle-recall
 *
 * ENVIRONMENTAL PRECONDITION (not test flake — pre-warm first on a busy box):
 * This exercises three Ollama models (nomic-embed + qwen3:8b for classify AND answer). On a loaded host
 * Ollama evicts/reloads between calls, and a cold reload can far exceed the recall path's 10s embed timeout
 * — measured 2026-08-24: qwen3:8b cold-load is ~1.8s idle but ~98s at load ~15 (54x). Symptom: an index
 * step reports "ollama embeddings unavailable: aborted due to timeout", or a query returns "Recall is
 * temporarily unavailable". Mitigations, all applied by the npm script / here: classifier + answer are
 * pinned to ONE model (qwen3:8b, fast now that noThink gives it think:false) to cut model-swap thrash, and
 * nomic-embed is pre-warmed. If it still trips, the host is genuinely saturated — retry when load subsides
 * (server-side, OLLAMA_KEEP_ALIVE=-1 keeps the answer model resident and removes the reload entirely).
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  grantAuthorization,
  selfSigner,
  signKbRequest,
  noThink,
  rankByQuery,
  PROTOCOL_VERSION,
  type KbRequestStatement,
  type KbResultMessage,
} from '@hearthold/core';
import { KbConfigStore, initKbAssurance, setKbAssurance, buildKbServices, provisionMemberPartition } from '@hearthold/warden/kb-config';
import { IndexStore } from '@hearthold/warden/index-store';
import { OllamaEmbedder } from '@hearthold/warden/recall';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

// A distinctive token that appears ONLY in the reader's private partition. If it ever shows up in a
// shared-scoped answer or citation, private content leaked through the public path.
const SECRET = 'OCTARINE-CANARY-7Q';
const PRIVATE_NOTE = `Private note: the reader's ${SECRET} keepsake color is octarine.`;
const SHARED_FACT = 'The City of Mages public chronicle records that the gate was named in the year 1776.';

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-e2e-oracle-recall';
  const SPACE = 'oracle-recall-kb';

  const warden = await openKeymaster('warden', config, pass);
  const reader = await openKeymaster('verifier', config, pass); // a member with read + a private partition
  const wardenId = await ensureIdentity(warden, config);
  const readerId = await ensureIdentity(reader, config);

  step('Provision a KB Space (member partitions on; read→factor2 + auto-approver so the ceiling admits any content)');
  // Deliberately neutralize the sensitivity CEILING for this test: set read→factor2 so kbCeiling=SEALED and
  // supply an auto-approving step-up. That isolates the property under test — scope:'shared' excludes the
  // reader's OWN partition — from the classifier's (crude, non-deterministic) per-doc sensitivity call, which
  // would otherwise filter synthetic fixtures at a factor1 MEDIUM ceiling and make retrieval flaky. The
  // classifier is still REAL (not quarantine); we just don't let its rating gate what recall can reach here.
  const readGroup = await createRegistryGroup(warden, `kb-read-${SPACE}`, config.registry);
  const writeGroup = await createRegistryGroup(warden, `kb-write-${SPACE}`, config.registry);
  await grantAuthorization(warden, readGroup, readerId.did);
  await grantAuthorization(warden, writeGroup, readerId.did);
  const genesis = await initKbAssurance(warden, config, SPACE, selfSigner(warden, wardenId.did));
  const policyAsset = await setKbAssurance(warden, config, SPACE, genesis, 'read', 'factor2', selfSigner(warden, wardenId.did));
  await new KbConfigStore(warden.dataFolder).put({ kbId: SPACE, readGroup, writeGroup, policyAsset, memberPartitions: true, defaultScope: 'private' });
  const readerPriv = await provisionMemberPartition(warden, config, SPACE, readerId.did);
  const approver = { requestActionApproval: async (): Promise<boolean> => true }; // auto-clear the factor2 read step-up
  const kb = (await buildKbServices(warden, config, wardenId.did, approver)).get(SPACE)!;

  const contribute = async (text: string, scope: 'shared' | 'private'): Promise<KbResultMessage> => {
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(reader, { action: 'update', requester: readerId.did, kbId: SPACE, nonce, kind: 'document', text, scope } as KbRequestStatement);
    return kb.serve(signed);
  };
  const query = async (q: string, scope?: 'shared'): Promise<{ answer: string; citations: { scope?: string }[] }> => {
    const nonce = kb.challenge().nonce;
    const signed = await signKbRequest(reader, { action: 'query', requester: readerId.did, kbId: SPACE, nonce, query: q, k: 5, ...(scope ? { scope } : {}) } as KbRequestStatement);
    const r = (await kb.serve(signed)) as KbResultMessage & { answer?: string; citations?: { scope?: string }[]; reason?: string };
    if (r.type !== 'hearthold/kb-result' || r.action !== 'query') throw new Error(`query failed: ${r.reason ?? r.type}`);
    return { answer: r.answer ?? '', citations: r.citations ?? [] };
  };

  step('Seed a SHARED public fact and a PRIVATE secret in the reader’s own partition');
  const s = await contribute(SHARED_FACT, 'shared');
  check('shared fact contributed + indexed', (s as { indexed?: boolean }).indexed === true);
  const p = await contribute(PRIVATE_NOTE, 'private');
  check('private secret contributed to the reader’s partition + indexed', (p as { indexed?: boolean }).indexed === true);

  step('B1 — a shared-scoped query is GROUNDED (citations > 0), rejecting the ok/citations:0 half-failure');
  const shared = await query('When was the gate named?', 'shared');
  check(`shared query answered with citations > 0 (got ${shared.citations.length})`, shared.citations.length > 0);
  check('no citation is from a private partition', shared.citations.every((c) => c.scope !== 'private'));
  check('the shared fact is actually recalled (answer mentions 1776)', /1776/.test(shared.answer));

  step('B2 — the SECRET is unreachable via a shared-scoped query (answer AND citations)');
  const probe = await query(`What is the reader's ${SECRET} keepsake color?`, 'shared');
  check('the secret token never appears in a shared-scoped ANSWER', !probe.answer.includes(SECRET) && !/octarine/i.test(probe.answer));
  check('no shared-scoped citation is private', probe.citations.every((c) => c.scope !== 'private'));

  step('B3 — CONTRAST (deterministic visible-set mechanism): scope:shared EXCLUDES the reader’s partition; the union INCLUDES it');
  // Prove the exclusion is the SCOPE, not a missing/unindexed doc — at the ranking layer directly, so it does
  // not depend on the LLM's phrasing or on a session key (private content is member-key sealed and only
  // readable in a live session; the read-guest path is covered by e2e:kb-member-key). The private doc is
  // indexed under the reader's OWN partition; a shared visible-set ([kbId]) drops it, a union ([kbId, own])
  // keeps it — which is exactly kb.ts's `if (own && req.scope !== 'shared') visible.push(own.id)`.
  const entries = await new IndexStore(warden.dataFolder).list();
  const privEntry = entries.find((e) => e.kb === readerPriv.id);
  check('the private doc IS indexed under the reader’s own partition (so exclusion is the scope, not a missing doc)', !!privEntry);
  const qEmb = await new OllamaEmbedder(config.ollamaUrl, config.embeddingModel).embed(`the reader's ${SECRET} keepsake color`);
  const inShared = rankByQuery(qEmb, entries, { k: 5, kb: [SPACE] }).some((r) => r.entry.artefactId === privEntry?.artefactId);
  const inUnion = rankByQuery(qEmb, entries, { k: 5, kb: [SPACE, readerPriv.id] }).some((r) => r.entry.artefactId === privEntry?.artefactId);
  check('the shared visible-set ([kbId]) EXCLUDES the private partition entry', privEntry !== undefined && !inShared);
  check('the union visible-set ([kbId, own]) INCLUDES it — reachable, just never under shared-scope', inUnion);

  step('A — thinking suppression on real Ollama, via our noThink(model)');
  const model = config.answerModel;
  if ('think' in noThink(model)) {
    const askOllama = async (useNoThink: boolean): Promise<number> => {
      const res = await fetch(`${config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, ...(useNoThink ? { think: false } : {}), options: { temperature: 0 }, messages: [{ role: 'user', content: 'Reply with just OK' }] }),
      });
      const data = (await res.json()) as { message?: { thinking?: string } };
      return (data.message?.thinking ?? '').length;
    };
    const withoutGate = await askOllama(false);
    const withGate = await askOllama(true);
    check(`the reasoning model DOES think without the gate (${withoutGate} chars)`, withoutGate > 0);
    check(`noThink('${model}') suppresses it: think.length === 0 (was ${withoutGate})`, withGate === 0);
  } else {
    process.stdout.write(`  – answer model '${model}' is not a reasoning model; think:false is a no-op here (assertion N/A — set HEARTHOLD_ANSWER_MODEL=qwen3:8b to exercise it)\n`);
  }

  process.stdout.write(`\n${failures === 0 ? '✓ oracle recall: shared-only isolation holds + thinking suppressed' : `✗ FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-oracle-recall: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
