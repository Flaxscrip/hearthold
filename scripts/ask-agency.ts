/**
 * Drive the local "agency" book KB — ask the corpus a question as the OWNER (through the challenge/response
 * wall, same as any member) and print the reasoned, cited answer. For a local demo/rehearsal of the private
 * book KB before it's served to David.
 *
 * Prereq: build it first — `… build:agency-kb` — into the SAME data root + passphrase used here.
 *   HEARTHOLD_DATA_ROOT=… HEARTHOLD_PASSPHRASE=… npm run ask:agency -- "your question"
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signKbRequest,
  type KbRequestStatement,
} from '@hearthold/core';
import { buildKbServices } from '@hearthold/warden/kb-config';

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    process.stderr.write('usage: npm run ask:agency -- "your question about the corpus"\n');
    process.exit(1);
  }
  const kbId = process.env.AGENCY_KB_ID ?? 'agency';
  const pass = process.env.HEARTHOLD_PASSPHRASE ?? 'agency-demo';
  // A book corpus is a deep-synthesis KB — reason over the retrieved passages (qwen3:8b) unless overridden.
  const config = { ...loadConfig(), answerModel: process.env.HEARTHOLD_ANSWER_MODEL ?? 'qwen3:8b' };

  const warden = await openKeymaster('warden', config, pass);
  const owner = await openKeymaster('sovereign', config, pass); // the KB owner (a read member)
  const wid = await ensureIdentity(warden, config);
  const ownerId = await ensureIdentity(owner, config);

  const kbs = await buildKbServices(warden, config, wid.did);
  const kb = kbs.get(kbId);
  if (!kb) {
    throw new Error(
      `KB "${kbId}" not found under ${config.dataRoot} — build it first with the same HEARTHOLD_DATA_ROOT + HEARTHOLD_PASSPHRASE (npm run build:agency-kb).`,
    );
  }

  process.stdout.write(`\n[1mQ:[0m ${question}\n\n(reasoning over the corpus…)\n`);
  const nonce = kb.challenge().nonce;
  const signed = await signKbRequest(
    owner,
    { action: 'query', requester: ownerId.did, kbId, nonce, query: question, k: 6 } as KbRequestStatement,
  );
  const res = await kb.serve(signed);
  if (res.type !== 'hearthold/kb-result') {
    throw new Error(`query refused: ${res.type} — ${(res as { reason?: string }).reason ?? ''}`);
  }
  const r = res as { answer?: string; citations?: { artefactId: string; score: number }[] };
  process.stdout.write(`\n[1mA:[0m ${r.answer ?? '(no answer)'}\n\n[2m${r.citations?.length ?? 0} citation(s) from the manuscript; the text never leaves the custodian.[0m\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`ask-agency: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
