#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  DidCommTransport,
  IDENTITY_NAME,
  AuthzTier,
  Sensitivity,
  requiredTier,
} from '@hearthold/core';

import { createClassifier } from './classifier.js';
import { VaultStore } from './store.js';
import { WardenService } from './service.js';
import { DelegationStore } from './delegations.js';
import { EvidenceService } from './evidence.js';
import { RecallService, OllamaEmbedder } from './recall.js';
import { makeWardenHandler } from './handler.js';

/** The recall-index embedder from config, or undefined when indexing is off. */
function makeEmbedder(config: ReturnType<typeof loadConfig>): OllamaEmbedder | undefined {
  return config.indexMode === 'ollama'
    ? new OllamaEmbedder(config.ollamaUrl, config.embeddingModel)
    : undefined;
}
import { runWardenControl } from './control.js';

const HELP = `Hearthold Warden — home Keeper

Usage:
  warden init              Provision the Warden identity + publish its DIDComm endpoint
  warden status            Show identity, vault size, and config
  warden publish           (Re)publish the Warden's DIDComm endpoint
  warden delegate <did>    Issue a delegation credential to a Witness DID
  warden serve             Serve over DIDComm (poll mailbox, store submissions, reply)
  warden control [port]    Serve DIDComm + a localhost control API for the Warden Console (default 4310)
  warden classify <kind> <text>   Classify text with the local model (test the classifier)
  warden vault             List stored artefacts (metadata only; payloads stay encrypted)
  warden recall <query>    Ask your own vault a question (local RAG; nothing leaves the device)
  warden help              Show this message

Env:
  HEARTHOLD_PASSPHRASE       wallet passphrase (required)
  HEARTHOLD_NODE_URL         Archon node (Drawbridge) URL; default http://flaxlap.local:4222
  HEARTHOLD_DATA_ROOT        default ~/.hearthold
  HEARTHOLD_OLLAMA_URL       local model endpoint; default http://localhost:11434
  HEARTHOLD_CLASSIFIER_MODEL default qwen3:8b
  HEARTHOLD_CLASSIFIER       set to 'quarantine' to disable the model (everything SEALED)
`;

const SENSITIVITY_NAMES = ['PUBLIC', 'LOW', 'MEDIUM', 'HIGH', 'SEALED'];

/**
 * Publish the Warden's DIDComm endpoint so peers can reach it even when `serve` isn't running
 * (the relay holds messages until the Warden next polls). Best-effort: returns false if the node's
 * DIDComm isn't available yet, leaving the identity intact to publish later.
 */
async function publishEndpoint(
  handle: Awaited<ReturnType<typeof openKeymaster>>,
  nodeUrl: string,
): Promise<boolean> {
  try {
    await new DidCommTransport(handle, IDENTITY_NAME.warden, nodeUrl).ready();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  const passphrase = process.env.HEARTHOLD_PASSPHRASE;
  if (!passphrase) {
    throw new Error('HEARTHOLD_PASSPHRASE is required');
  }

  const handle = await openKeymaster('warden', config, passphrase);

  switch (cmd) {
    case 'init': {
      const id = await ensureIdentity(handle, config);
      const published = await publishEndpoint(handle, config.nodeUrl);
      process.stdout.write(
        `Warden ready\n  name: ${id.name}\n  did:  ${id.did}\n` +
          `  didcomm: ${
            published
              ? 'endpoint published'
              : 'NOT published — run `warden publish` once the node DIDComm is up'
          }\n`,
      );
      break;
    }
    case 'publish': {
      await ensureIdentity(handle, config);
      await new DidCommTransport(handle, IDENTITY_NAME.warden, config.nodeUrl).ready();
      process.stdout.write('Warden DIDComm endpoint published.\n');
      break;
    }
    case 'status': {
      const id = await ensureIdentity(handle, config);
      const items = await new VaultStore(handle.dataFolder).list();
      const classifier =
        config.classifierMode === 'ollama'
          ? `ollama ${config.classifierModel} @ ${config.ollamaUrl}`
          : 'quarantine (model disabled)';
      process.stdout.write(
        `Warden ${id.did}\n` +
          `  node:       ${config.nodeUrl}\n` +
          `  data:       ${handle.dataFolder}\n` +
          `  classifier: ${classifier}\n` +
          `  artefacts:  ${items.length}\n` +
          `  e.g. SEALED requires tier ${requiredTier(Sensitivity.SEALED)} ` +
          `(MULTIFACTOR=${AuthzTier.MULTIFACTOR})\n`,
      );
      break;
    }
    case 'classify': {
      const kind = process.argv[3];
      const text = process.argv.slice(4).join(' ');
      if (!kind || !text) throw new Error('usage: warden classify <kind> <text>');
      const result = await createClassifier(config).classify({ kind, text });
      const tags = (result.metadata.tags as string[] | undefined)?.join(', ') ?? '';
      process.stdout.write(
        `sensitivity: ${result.sensitivity} (${SENSITIVITY_NAMES[result.sensitivity]})\n` +
          `  tags:    ${tags}\n` +
          `  reason:  ${result.metadata.reason ?? result.metadata.error ?? ''}\n` +
          `  confirm: ${result.needsHumanConfirmation}\n`,
      );
      break;
    }
    case 'delegate': {
      const witnessDid = process.argv[3];
      if (!witnessDid) throw new Error('usage: warden delegate <witnessDid>');
      await ensureIdentity(handle, config);
      const schemaDid = await ensureDelegationSchema(handle);
      const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
      const credentialDid = await issueDelegation(handle, witnessDid, schemaDid, {
        kinds: ['event', 'location', 'activity', 'browsing', 'document'],
        validUntil,
      });
      await new DelegationStore(handle).record(witnessDid, credentialDid);
      process.stdout.write(
        `Delegation issued to ${witnessDid.slice(0, 28)}…\n` +
          `  credential: ${credentialDid}\n` +
          `  → optionally run on the Witness:  witness accept ${credentialDid}\n`,
      );
      break;
    }
    case 'serve': {
      const id = await ensureIdentity(handle, config);
      const transport = new DidCommTransport(handle, IDENTITY_NAME.warden, config.nodeUrl);
      await transport.ready();
      const handler = makeWardenHandler(
        new WardenService(handle, createClassifier(config), makeEmbedder(config)),
        new DelegationStore(handle),
        new EvidenceService(handle, config),
      );
      const stop = await transport.serve(handler);
      process.stdout.write(
        `Warden serving over DIDComm\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  (Ctrl-C to stop)\n`,
      );
      const shutdown = (): void => {
        stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'control': {
      const port = Number(process.argv[3] ?? process.env.HEARTHOLD_CONTROL_PORT ?? 4310);
      await runWardenControl(handle, config, port);
      break;
    }
    case 'vault': {
      await ensureIdentity(handle, config);
      const items = await new WardenService(handle).listArtefacts();
      if (items.length === 0) {
        process.stdout.write('Vault is empty.\n');
        break;
      }
      for (const a of items) {
        process.stdout.write(
          `[${a.sensitivity}] ${a.kind} observed ${a.observedAt} · ${a.id.slice(0, 28)}…\n`,
        );
      }
      process.stdout.write(`${items.length} artefact(s).\n`);
      break;
    }
    case 'recall': {
      const query = process.argv.slice(3).join(' ');
      if (!query) throw new Error('usage: warden recall <query>');
      await ensureIdentity(handle, config);
      const result = await RecallService.forWarden(handle, config).recall(query);
      process.stdout.write(`\n🔎 ${result.answer}\n`);
      if (result.citations.length > 0) {
        process.stdout.write(`\n  from ${result.citations.length} note(s):\n`);
        for (const c of result.citations) {
          process.stdout.write(`   · [${c.kind}] ${c.observedAt} (${c.score.toFixed(2)}) ${c.artefactId.slice(0, 20)}…\n`);
        }
      }
      process.stdout.write(`\n  (machine-derived from your vault — local only; to prove a fact, use the evidence flow)\n`);
      break;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`warden: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
