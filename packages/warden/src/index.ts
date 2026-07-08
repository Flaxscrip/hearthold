#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  createRegistryGroup,
  grantAuthorization,
  revokeAuthorization,
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
import { makeDidcommActionApprover } from './kb.js';
import { KbConfigStore, buildKbService, initKbAssurance, setKbAssurance, readKbAssurance } from './kb-config.js';
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
  warden kb-init <kbId>    Provision a shared Knowledge Base (read/write access groups)
  warden kb-grant <did> [read|write|both]   Authorize a Sovereign DID on the KB (default both)
  warden kb-revoke <did> [read|write|both]  Revoke a Sovereign's KB authorization
  warden kb-policy <action> <factor1|factor2>   Set required assurance for a KB action (governance)
  warden kb-status         Show the KB config, members, and assurance policy
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
      const kb = await buildKbService(handle, config, id.did, makeDidcommActionApprover(transport));
      const handler = makeWardenHandler(
        new WardenService(handle, createClassifier(config), makeEmbedder(config)),
        new DelegationStore(handle),
        new EvidenceService(handle, config),
        kb,
      );
      const stop = await transport.serve(handler);
      process.stdout.write(
        `Warden serving over DIDComm\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  kb:   ${kb ? 'serving a Knowledge Base' : 'none provisioned'}\n` +
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
    case 'kb-init': {
      const kbId = process.argv[3];
      if (!kbId) throw new Error('usage: warden kb-init <kbId>');
      await ensureIdentity(handle, config);
      const store = new KbConfigStore(handle.dataFolder);
      if (await store.read()) throw new Error('a KB is already provisioned for this Warden');
      const readGroup = await createRegistryGroup(handle, `kb-read-${kbId}`, config.registry);
      const writeGroup = await createRegistryGroup(handle, `kb-write-${kbId}`, config.registry);
      // Governance policy — a signed genesis Ruleset chain (default: everything factor1).
      const policyAsset = await initKbAssurance(handle, config, kbId);
      await store.save({ kbId, readGroup, writeGroup, policyAsset });
      process.stdout.write(
        `Knowledge Base "${kbId}" provisioned\n` +
          `  read group:  ${readGroup}\n  write group: ${writeGroup}\n  policy:      ${policyAsset}\n` +
          `  → grant members:  warden kb-grant <sovereignDid>\n` +
          `  → raise assurance: warden kb-policy write factor2\n` +
          `  → serve it:       warden serve   (or warden control)\n`,
      );
      break;
    }
    case 'kb-policy': {
      const action = process.argv[3];
      const tier = process.argv[4];
      if (!action || (tier !== 'factor1' && tier !== 'factor2')) {
        throw new Error('usage: warden kb-policy <action> <factor1|factor2>  (e.g. kb-policy write factor2)');
      }
      await ensureIdentity(handle, config);
      const store = new KbConfigStore(handle.dataFolder);
      const kb = await store.read();
      if (!kb) throw new Error('no KB provisioned — run `warden kb-init <kbId>` first');
      // Append a Sovereign-signed Ruleset version raising/lowering the tier; re-anchor the chain.
      const policyAsset = await setKbAssurance(handle, config, kb.kbId, kb.policyAsset, action, tier);
      await store.save({ ...kb, policyAsset });
      process.stdout.write(`Policy set (signed): ${action} → ${tier} on "${kb.kbId}"\n  chain: ${policyAsset}\n`);
      break;
    }
    case 'kb-grant':
    case 'kb-revoke': {
      const did = process.argv[3];
      const scope = (process.argv[4] ?? 'both').toLowerCase();
      if (!did) throw new Error(`usage: warden ${cmd} <sovereignDid> [read|write|both]`);
      await ensureIdentity(handle, config);
      const kb = await new KbConfigStore(handle.dataFolder).read();
      if (!kb) throw new Error('no KB provisioned — run `warden kb-init <kbId>` first');
      const groups: string[] = [];
      if (scope === 'read' || scope === 'both') groups.push(kb.readGroup);
      if (scope === 'write' || scope === 'both') groups.push(kb.writeGroup);
      if (groups.length === 0) throw new Error('scope must be read | write | both');
      for (const g of groups) {
        if (cmd === 'kb-grant') await grantAuthorization(handle, g, did);
        else await revokeAuthorization(handle, g, did);
      }
      process.stdout.write(
        `${cmd === 'kb-grant' ? 'Granted' : 'Revoked'} ${scope} for ${did.slice(0, 28)}… on "${kb.kbId}"\n`,
      );
      break;
    }
    case 'kb-status': {
      await ensureIdentity(handle, config);
      const kb = await new KbConfigStore(handle.dataFolder).read();
      if (!kb) {
        process.stdout.write('No Knowledge Base provisioned. Run `warden kb-init <kbId>`.\n');
        break;
      }
      const members = async (group: string): Promise<string[]> => {
        const g = (await handle.keymaster.getGroup(group).catch(() => null)) as { members?: string[] } | null;
        return g?.members ?? [];
      };
      const readers = await members(kb.readGroup);
      const writers = await members(kb.writeGroup);
      const policy = await readKbAssurance(handle, kb.policyAsset);
      process.stdout.write(
        `Knowledge Base "${kb.kbId}"\n` +
          `  read group:  ${kb.readGroup}\n    ${readers.length} member(s): ${readers.map((m) => m.slice(0, 20) + '…').join(', ') || '(none)'}\n` +
          `  write group: ${kb.writeGroup}\n    ${writers.length} member(s): ${writers.map((m) => m.slice(0, 20) + '…').join(', ') || '(none)'}\n` +
          `  assurance:   read → ${policy.read} · write → ${policy.write}  (signed Ruleset chain)\n`,
      );
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
