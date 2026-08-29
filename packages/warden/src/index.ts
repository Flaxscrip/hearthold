#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  passphraseFor,
  runKeyMaintenance,
  ensureIdentity,
  type WitnessKind,
  ensureDelegationSchema,
  ensureAuthorizationSchema,
  issueDelegation,
  createRegistryGroup,
  grantAuthorization,
  revokeAuthorization,
  DidCommTransport,
  IDENTITY_NAME,
  AuthzTier,
  Sensitivity,
  requiredTier,
  selfSigner,
  type KeymasterHandle,
} from '@hearthold/core';

import { createClassifier } from './classifier.js';
import { createVisionCaptioner } from './vision.js';
import { AutofileStore } from './autofile-store.js';
import { VaultStore } from './store.js';
import { WardenService } from './service.js';
import { DelegationStore } from './delegations.js';
import { EvidenceService, makeDidcommDischargeRequester } from './evidence.js';
import { ChallengeStore } from './challenge-store.js';
import { RecallService, OllamaEmbedder } from './recall.js';
import { makeDidcommActionApprover, makeDidcommRulesetSigner } from './kb.js';
import { KbConfigStore, buildKbServices, initKbAssurance, setKbAssurance, readKbAssurance, provisionMemberPartition, enableMemberPartitions } from './kb-config.js';
import type { RewrapChannel } from './rewrap.js';
import { reindexKb } from './reindex.js';
import { backfillOwner } from './migrate-owner.js';
import { HouseholdConfigStore } from './household-config.js';
import { HouseholdVault } from './household-vault.js';
import { seedKb, resetKb, DEMO_SETS, DEFAULT_DEMO_SET } from './kb-seed.js';
import { registerComposerSchemas } from './composer-schemas.js';
import { makeWardenHandler } from './handler.js';

/** The recall-index embedder from config, or undefined when indexing is off. */
function makeEmbedder(config: ReturnType<typeof loadConfig>): OllamaEmbedder | undefined {
  return config.indexMode === 'ollama'
    ? new OllamaEmbedder(config.ollamaUrl, config.embeddingModel)
    : undefined;
}

/**
 * A Ruleset signer for a one-shot CLI policy command. When a governing Sovereign DID is given, opens a
 * transient transport and routes signing to that Sovereign's Signet (it must be serving); otherwise the
 * Warden self-signs (self-governed). Returns the signer + a cleanup for any opened transport.
 */
async function cliRulesetSigner(
  handle: KeymasterHandle,
  config: ReturnType<typeof loadConfig>,
  wardenDid: string,
  governorDid?: string,
): Promise<{ signer: import('@hearthold/core').RulesetSigner; done: () => void }> {
  if (!governorDid) return { signer: selfSigner(handle, wardenDid), done: () => {} };
  const transport = new DidCommTransport(handle, IDENTITY_NAME.warden, config.nodeUrl);
  await transport.ready();
  process.stdout.write(`  → requesting the Sovereign's signature at the Signet (${governorDid.slice(0, 20)}…)…\n`);
  return { signer: makeDidcommRulesetSigner(transport, governorDid), done: () => {} };
}

/** Resolve the target KB for a CLI command: `--kb <kbId>`, else the sole provisioned KB. */
async function resolveKb(store: KbConfigStore): Promise<import('./kb-config.js').KbConfig> {
  const ki = process.argv.indexOf('--kb');
  const kbId = ki > 0 ? process.argv[ki + 1] : undefined;
  const kb = await store.get(kbId);
  if (!kb) {
    const all = await store.list();
    if (all.length === 0) throw new Error('no KB provisioned — run `warden kb-init <kbId>` first');
    throw new Error(`ambiguous KB — this Warden holds ${all.length} (${all.map((k) => k.kbId).join(', ')}); pass --kb <kbId>`);
  }
  return kb;
}
import { runWardenControl } from './control.js';

const HELP = `Hearthold Warden — home Keeper

Usage:
  warden init              Provision the Warden identity + publish its DIDComm endpoint
  warden status            Show identity, vault size, and config
  warden publish           (Re)publish the Warden's DIDComm endpoint (publish-if-absent / reconcile)
  warden republish [--endpoint <uri>]  Force-(re)publish the DIDComm endpoint (re-home onto a new address)
  warden delegate <did>    Issue a delegation credential to an Emissary DID
  warden register-schemas  Register composer schemas (Endorsement/Membership/Ticket) on the registry
  warden serve             Serve over DIDComm (poll mailbox, store submissions, reply)
  warden control [port]    Serve DIDComm + a localhost control API for the Warden Console (default 4310)
  warden classify <kind> <text>   Classify text with the local model (test the classifier)
  warden vault             List stored artefacts (metadata only; payloads stay encrypted)
  warden recall <query>    Ask your own vault a question (local RAG; nothing leaves the device)
  warden kb-init <kbId> [--governor <did>]  Provision a Knowledge Base (many per Warden)
  warden kb-govern <sovereignDid> [--kb <kbId>]  Adopt Signet governance on an existing KB
  warden kb-grant <did> [read|write|both] [--kb <kbId>]   Authorize a member DID on a KB
  warden kb-revoke <did> [read|write|both] [--kb <kbId>]  Revoke a member's KB authorization
  warden kb-policy <action> <factor1|factor2> [--kb <kbId>]   Set required assurance (governance)
  warden kb-spaces enable [--default-scope shared|private] [--kb <kbId>]  Turn on per-member private partitions for an existing KB (backfills current members)
  warden kb-status         List all Knowledge Bases: members + assurance policy
  warden kb-seed [--kb <kbId>] [--set <name>]   Load curated demo data into a KB
  warden kb-reset [--kb <kbId>]                 Remove a KB's data (identity/groups/policy kept)
  warden kb-reindex [--kb <kbId>]              Backfill the recall index (embed stored-but-unindexed content)
  warden migrate-owner                         Attribute pre-family vault artefacts to the Sovereign (family model)
  warden household-init <id> [--governor <did>]  Provision a household: shared Vault + rosters + genesis Ruleset
  warden autofile-grant <emissaryDid>   Trust an Emissary to auto-file (bypass ingestion quarantine)
  warden autofile-revoke <emissaryDid>  Revoke autofile trust (its submissions quarantine again)
  warden autofile-list                  List autofile-trusted Emissaries
  warden change-registry <registry>  Move the Warden IDENTITY to another registry (e.g. hyperswarm) — SAME
                           DID + keys, sealed vault untouched (NOT a rotation). Needed so a member-gated KB's
                           Warden is publicly resolvable; wait for it to CONFIRM before relying on it.
  warden rotate            Rotate the Warden's signing keys (incident response; DIDs keep resolving)
  warden passphrase <new>  Re-encrypt the wallet under a new passphrase (then update the env)
  warden check             Health-check the wallet
  warden help              Show this message

Env:
  HEARTHOLD_PASSPHRASE       wallet passphrase — shared, or per-role HEARTHOLD_PASSPHRASE_WARDEN (required)
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
  const passphrase = passphraseFor('warden');

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
    case 'republish': {
      // Force-(re)publish the DIDComm endpoint after first boot — re-home onto a new reachable address
      // (Tor onion / tailnet / migrated host). `--endpoint <uri>` overrides HEARTHOLD_DIDCOMM_ENDPOINT/node.
      await ensureIdentity(handle, config);
      const ei = process.argv.indexOf('--endpoint');
      const endpoint = ei > 0 ? process.argv[ei + 1] : undefined;
      const { endpoint: pub, previous } = await new DidCommTransport(handle, IDENTITY_NAME.warden, config.nodeUrl).republish(endpoint);
      process.stdout.write(`Warden DIDComm endpoint republished\n${previous ? `  was: ${previous}\n` : ''}  now: ${pub}\n`);
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
    case 'register-schemas': {
      // Register the composer-friendly credential schemas (Endorsement/Membership/Ticket, titled + fielded)
      // on this Warden's registry so the Table's Compose-a-card has meaningful types to mint. Idempotent.
      await ensureIdentity(handle, config);
      const results = await registerComposerSchemas(handle);
      process.stdout.write('Composer schemas on this Warden registry:\n');
      for (const r of results) {
        process.stdout.write(`  ${r.created ? 'registered' : 'exists    '}  ${r.title.padEnd(12)} ${r.did}\n`);
      }
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
      const emissaryDid = process.argv[3];
      if (!emissaryDid) throw new Error('usage: warden delegate <emissaryDid> [--kinds image,document,…]');
      await ensureIdentity(handle, config);
      const schemaDid = await ensureDelegationSchema(handle);
      const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
      // Scope a per-path Emissary with --kinds (e.g. `--kinds image` for a dedicated image Emissary); default
      // is the text set (no `image` — that path gets its own separately-revocable delegation).
      const ki = process.argv.indexOf('--kinds');
      const kinds = (ki > 0 && process.argv[ki + 1] ? process.argv[ki + 1]!.split(',').map((s) => s.trim()).filter(Boolean) : ['event', 'location', 'activity', 'browsing', 'document', 'book', 'link']) as WitnessKind[];
      const credentialDid = await issueDelegation(handle, emissaryDid, schemaDid, { kinds, validUntil });
      await new DelegationStore(handle).record(emissaryDid, credentialDid, undefined, kinds);
      process.stdout.write(
        `Delegation issued to ${emissaryDid.slice(0, 28)}…\n` +
          `  kinds:      ${kinds.join(', ')}\n` +
          `  credential: ${credentialDid}\n` +
          `  → optionally run on the Emissary:  emissary accept ${credentialDid}\n`,
      );
      break;
    }
    case 'serve': {
      const id = await ensureIdentity(handle, config);
      const transport = new DidCommTransport(handle, IDENTITY_NAME.warden, config.nodeUrl);
      await transport.ready();
      const kbs = await buildKbServices(handle, config, id.did, makeDidcommActionApprover(transport), transport as unknown as RewrapChannel);
      const handler = makeWardenHandler(
        new WardenService(handle, createClassifier(config), makeEmbedder(config), createVisionCaptioner(config)),
        new DelegationStore(handle),
        // Consent channel to the owner's Signet (§3) + Warden-minted challenge store (§1).
        new EvidenceService(handle, config, makeDidcommDischargeRequester(transport)),
        kbs,
        config.sovereignDid,
        undefined,
        undefined,
        new ChallengeStore(handle, config.registry, config.sovereignDid, config.authorizationSchemaDid),
      );
      const stop = await transport.serve(handler);
      // Surface the canonical authorization schema DID so an operator can wire it into the Sovereign's
      // HEARTHOLD_AUTHORIZATION_SCHEMA_DID (schema DIDs aren't content-addressed across wallets — the issuer
      // must reference the Warden's, not register its own). Also on `warden control`'s /api/status.
      const authSchema = config.authorizationSchemaDid ?? (await ensureAuthorizationSchema(handle));
      process.stdout.write(
        `Warden serving over DIDComm\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  kb:   ${kbs.size ? `serving ${kbs.size} Knowledge Base(s): ${[...kbs.keys()].join(', ')}` : 'none provisioned'}\n` +
          `  auth-schema: ${authSchema}\n` +
          `    ↳ set HEARTHOLD_AUTHORIZATION_SCHEMA_DID to this on the Sovereign so its grants match.\n` +
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
      await runWardenControl(handle, config, port, passphrase);
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
      if (!kbId || kbId.startsWith('--')) throw new Error('usage: warden kb-init <kbId> [--governor <sovereignDid>] [--member-partitions] [--default-scope shared|private]');
      const gi = process.argv.indexOf('--governor');
      const governorDid = gi > 0 ? process.argv[gi + 1] : config.sovereignDid;
      const memberPartitions = process.argv.includes('--member-partitions');
      const dsi = process.argv.indexOf('--default-scope');
      const defaultScope = dsi > 0 && (process.argv[dsi + 1] === 'private' || process.argv[dsi + 1] === 'shared') ? (process.argv[dsi + 1] as 'shared' | 'private') : undefined;
      const id = await ensureIdentity(handle, config);
      const store = new KbConfigStore(handle.dataFolder);
      if (await store.get(kbId)) throw new Error(`KB "${kbId}" is already provisioned (each Warden can hold many KBs — pick a new id)`);
      const readGroup = await createRegistryGroup(handle, `kb-read-${kbId}`, config.registry);
      const writeGroup = await createRegistryGroup(handle, `kb-write-${kbId}`, config.registry);
      // Governance policy — a genesis Ruleset signed by the governor (the Sovereign via the Signet, or
      // the Warden itself if self-governed). Readers pin the governor DID.
      const { signer } = await cliRulesetSigner(handle, config, id.did, governorDid);
      const policyAsset = await initKbAssurance(handle, config, kbId, signer);
      await store.put({ kbId, readGroup, writeGroup, policyAsset, governorDid, memberPartitions: memberPartitions || undefined, defaultScope });
      process.stdout.write(
        `Knowledge Base "${kbId}" provisioned\n` +
          `  read group:  ${readGroup}\n  write group: ${writeGroup}\n  policy:      ${policyAsset}\n` +
          `  governance:  ${governorDid ? `Sovereign ${governorDid.slice(0, 20)}… (signs at the Signet)` : 'self-governed (Warden signs)'}\n` +
          (memberPartitions ? `  spaces:      member partitions ON (each grant gets a private DB; default contribute = ${defaultScope ?? 'shared'})\n` : '') +
          `  → grant members:  warden kb-grant <sovereignDid> both --kb ${kbId}\n` +
          `  → raise assurance: warden kb-policy write factor2 --kb ${kbId}\n` +
          `  → serve it:       warden serve   (or warden control)\n`,
      );
      break;
    }
    case 'kb-govern': {
      const governorDid = process.argv[3];
      if (!governorDid || governorDid.startsWith('--')) throw new Error('usage: warden kb-govern <sovereignDid> [--kb <kbId>]');
      const id = await ensureIdentity(handle, config);
      const store = new KbConfigStore(handle.dataFolder);
      const kb = await resolveKb(store);
      // Adopt Signet governance in place: re-genesis the policy chain under the new governor (the Signet
      // signs), keeping the existing groups + members. A governor change starts a fresh chain by design.
      const { signer } = await cliRulesetSigner(handle, config, id.did, governorDid);
      const policyAsset = await initKbAssurance(handle, config, kb.kbId, signer);
      await store.put({ ...kb, governorDid, policyAsset });
      process.stdout.write(
        `"${kb.kbId}" is now governed by the Sovereign ${governorDid.slice(0, 20)}…\n` +
          `  (members preserved; assurance reset to factor1 baseline — re-raise with kb-policy)\n  chain: ${policyAsset}\n`,
      );
      break;
    }
    case 'kb-policy': {
      const action = process.argv[3];
      const tier = process.argv[4];
      if (!action || (tier !== 'factor1' && tier !== 'factor2')) {
        throw new Error('usage: warden kb-policy <action> <factor1|factor2> [--kb <kbId>]');
      }
      const id = await ensureIdentity(handle, config);
      const store = new KbConfigStore(handle.dataFolder);
      const kb = await resolveKb(store);
      // Append a version signed by the KB's governor (the Sovereign at the Signet, or self).
      const { signer } = await cliRulesetSigner(handle, config, id.did, kb.governorDid);
      const policyAsset = await setKbAssurance(handle, config, kb.kbId, kb.policyAsset, action, tier, signer);
      await store.put({ ...kb, policyAsset });
      process.stdout.write(`Policy set (signed by ${kb.governorDid ? 'the Sovereign' : 'the Warden'}): ${action} → ${tier} on "${kb.kbId}"\n  chain: ${policyAsset}\n`);
      break;
    }
    case 'kb-grant':
    case 'kb-revoke': {
      const did = process.argv[3];
      const scope = (process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : 'both').toLowerCase();
      if (!did) throw new Error(`usage: warden ${cmd} <sovereignDid> [read|write|both] [--kb <kbId>]`);
      await ensureIdentity(handle, config);
      const kb = await resolveKb(new KbConfigStore(handle.dataFolder));
      const groups: string[] = [];
      if (scope === 'read' || scope === 'both') groups.push(kb.readGroup);
      if (scope === 'write' || scope === 'both') groups.push(kb.writeGroup);
      if (groups.length === 0) throw new Error('scope must be read | write | both');
      for (const g of groups) {
        if (cmd === 'kb-grant') await grantAuthorization(handle, g, did);
        else await revokeAuthorization(handle, g, did);
      }
      // KB Spaces: granting a member also provisions their private partition (their private DB). The
      // partition (and its data) is retained on revoke — deletion is a separate, explicit op.
      let partNote = '';
      if (cmd === 'kb-grant' && kb.memberPartitions) {
        const part = await provisionMemberPartition(handle, config, kb.kbId, did);
        partNote = `  private partition: ${part.id}\n`;
      }
      process.stdout.write(
        `${cmd === 'kb-grant' ? 'Granted' : 'Revoked'} ${scope} for ${did.slice(0, 28)}… on "${kb.kbId}"\n` + partNote,
      );
      break;
    }
    case 'kb-spaces': {
      const sub = process.argv[3];
      if (sub !== 'enable') throw new Error('usage: warden kb-spaces enable [--default-scope shared|private] [--kb <kbId>]');
      await ensureIdentity(handle, config);
      const store = new KbConfigStore(handle.dataFolder);
      const kb = await resolveKb(store);
      const dsi = process.argv.indexOf('--default-scope');
      const defaultScope =
        dsi > 0 && (process.argv[dsi + 1] === 'private' || process.argv[dsi + 1] === 'shared')
          ? (process.argv[dsi + 1] as 'shared' | 'private')
          : undefined;
      // Flip the flag + backfill every current member's private partition (idempotent, non-destructive).
      const { alreadyOn, members } = await enableMemberPartitions(handle, config, store, kb, defaultScope);
      const scope = defaultScope ?? kb.defaultScope ?? 'shared';
      process.stdout.write(
        `Member partitions ${alreadyOn ? 'reaffirmed' : 'enabled'} on "${kb.kbId}"\n` +
          `  default contribute: ${scope} (scope-less contributions land here)\n` +
          `  backfilled ${members.length} member partition(s): ${members.map((m) => m.slice(0, 20) + '…').join(', ') || '(no members yet — each future kb-grant provisions one)'}\n` +
          `  existing shared content is untouched; each member now has an (empty) private partition\n`,
      );
      break;
    }
    case 'kb-status': {
      await ensureIdentity(handle, config);
      const kbs = await new KbConfigStore(handle.dataFolder).list();
      if (kbs.length === 0) {
        process.stdout.write('No Knowledge Base provisioned. Run `warden kb-init <kbId>`.\n');
        break;
      }
      const members = async (group: string): Promise<string[]> => {
        const g = (await handle.keymaster.getGroup(group).catch(() => null)) as { members?: string[] } | null;
        return g?.members ?? [];
      };
      for (const kb of kbs) {
        const readers = await members(kb.readGroup);
        const writers = await members(kb.writeGroup);
        const policy = await readKbAssurance(handle, kb.policyAsset, kb.governorDid);
        process.stdout.write(
          `Knowledge Base "${kb.kbId}"  (${kb.governorDid ? 'Sovereign-governed' : 'self-governed'})\n` +
            `  read:  ${readers.length} member(s): ${readers.map((m) => m.slice(0, 20) + '…').join(', ') || '(none)'}\n` +
            `  write: ${writers.length} member(s): ${writers.map((m) => m.slice(0, 20) + '…').join(', ') || '(none)'}\n` +
            `  assurance: read → ${policy.read} · write → ${policy.write}\n`,
        );
      }
      break;
    }
    case 'kb-seed': {
      const si = process.argv.indexOf('--set');
      const setName = si > 0 ? (process.argv[si + 1] as string) : DEFAULT_DEMO_SET;
      if (!DEMO_SETS[setName]) throw new Error(`unknown demo set "${setName}" (have: ${Object.keys(DEMO_SETS).join(', ')})`);
      const id = await ensureIdentity(handle, config);
      const kb = await resolveKb(new KbConfigStore(handle.dataFolder));
      const { loaded, set } = await seedKb(handle, config, id.did, kb.kbId, setName);
      process.stdout.write(`Loaded ${loaded} demo card(s) from the "${set}" set into "${kb.kbId}".\n  → ask the portal something, then \`warden kb-reset --kb ${kb.kbId}\` to start fresh.\n`);
      break;
    }
    case 'kb-reset': {
      await ensureIdentity(handle, config);
      const kb = await resolveKb(new KbConfigStore(handle.dataFolder));
      const { removed, shared, private: priv } = await resetKb(handle, kb.kbId);
      process.stdout.write(
        `Reset "${kb.kbId}": removed ${removed} artefact(s) + index entries ` +
          `(${shared} shared · ${priv} in member private partitions). ` +
          `Identity, access groups, and member partitions are untouched.\n`,
      );
      break;
    }
    case 'household-init': {
      // Provision a household: a Warden-owned shared Archon Vault + read/write rosters + a governor-signed
      // genesis Ruleset. Members are admitted via the daemon's /api/household/admit (governor-authorized).
      const householdId = process.argv[3];
      if (!householdId || householdId.startsWith('--')) throw new Error('usage: warden household-init <householdId> [--governor <sovereignDid>]');
      const gi = process.argv.indexOf('--governor');
      const governorDid = gi > 0 ? process.argv[gi + 1] : config.sovereignDid;
      const id = await ensureIdentity(handle, config);
      const hstore = new HouseholdConfigStore(handle.dataFolder);
      if (await hstore.get(householdId)) throw new Error(`household "${householdId}" already exists`);
      const vault = await HouseholdVault.create(handle, config);
      const readGroup = await createRegistryGroup(handle, `hh-read-${householdId}`, config.registry);
      const writeGroup = await createRegistryGroup(handle, `hh-write-${householdId}`, config.registry);
      const { signer } = await cliRulesetSigner(handle, config, id.did, governorDid);
      const policyAsset = await initKbAssurance(handle, config, householdId, signer);
      await hstore.put({ householdId, sharedVaultDid: vault.did, governorDid: governorDid ?? id.did, policyAsset, readGroup, writeGroup, memberPartitions: true, governorObservesActivity: false });
      process.stdout.write(
        `Household "${householdId}" provisioned\n  shared vault: ${vault.did}\n` +
          `  governor:     ${governorDid ? `${governorDid.slice(0, 24)}… (signs at the Signet)` : 'self-governed (Warden)'}\n` +
          `  → admit a member:  POST /api/household/admit { memberDid }  (governor-authorized, warden control)\n`,
      );
      break;
    }
    case 'migrate-owner': {
      // Attribute pre-family vault artefacts to the configured Sovereign (owner + scope:'private'), so
      // session-scoped recall/snapshot show the Sovereign their own content. Idempotent. Run kb-reindex
      // afterwards to propagate ownership to the recall index.
      await ensureIdentity(handle, config);
      const n = await backfillOwner(handle, config);
      process.stdout.write(
        `Attributed ${n} pre-family artefact(s) to the Sovereign ${config.sovereignDid?.slice(0, 24)}… (scope: private).\n` +
          (n > 0 ? `  → run \`warden kb-reindex\` to propagate ownership into the recall index.\n` : '  (nothing to attribute — all artefacts already have an owner)\n'),
      );
      break;
    }
    case 'kb-reindex': {
      // Backfill the recall index: embed any stored-but-unindexed artefacts (e.g. contributions whose
      // embed dropped when the embedder was overloaded). Idempotent — never duplicates. Run when the
      // embedder has headroom. `--kb <id>` scopes to one KB/space; omit to sweep everything.
      await ensureIdentity(handle, config);
      const ki = process.argv.indexOf('--kb');
      const kbFilter = ki > 0 ? process.argv[ki + 1] : undefined;
      process.stdout.write(`Re-indexing${kbFilter ? ` "${kbFilter}"` : ' all KB content'}…\n`);
      const r = await reindexKb(handle, config, { kb: kbFilter });
      process.stdout.write(
        `  scanned ${r.scanned} · already-indexed ${r.alreadyIndexed} · backfilled ${r.backfilled} · skipped ${r.skipped} · failed ${r.failed}\n` +
          (r.failed > 0 ? `  ⚠ ${r.failed} still failed to embed — the embedder may be down; re-run when it has headroom.\n` : '') +
          (r.backfilled > 0 ? `  ✓ ${r.backfilled} artefact(s) are now searchable.\n` : ''),
      );
      break;
    }
    case 'autofile-grant':
    case 'autofile-revoke':
    case 'autofile-list': {
      // Manage the autofile trust group: Emissaries in it BYPASS ingestion quarantine (auto-file);
      // everyone else quarantines born-obsidian until the Sovereign confirms. Same group-membership model
      // as KB read/write. The group is created on first grant and its DID persisted in autofile.json.
      await ensureIdentity(handle, config);
      const autofile = new AutofileStore(handle.dataFolder);
      if (cmd === 'autofile-list') {
        const group = autofile.group();
        if (!group) {
          process.stdout.write('No autofile group yet — everything quarantines (safe default).\n');
          break;
        }
        const g = (await handle.keymaster.getGroup(group).catch(() => null)) as { members?: string[] } | null;
        const members = g?.members ?? [];
        process.stdout.write(
          `Autofile-trusted Emissaries (${members.length}) [group ${group.slice(0, 28)}…]:\n` +
            (members.length ? members.map((m) => `  · ${m}\n`).join('') : '  (none)\n'),
        );
        break;
      }
      const did = process.argv[3];
      if (!did) throw new Error(`usage: warden ${cmd} <emissaryDid>`);
      let group = autofile.group();
      if (!group) {
        if (cmd === 'autofile-revoke') {
          process.stdout.write('No autofile group — nothing to revoke.\n');
          break;
        }
        group = await createRegistryGroup(handle, 'hearthold-autofile', config.registry);
        autofile.setGroup(group);
      }
      const ok =
        cmd === 'autofile-grant'
          ? await grantAuthorization(handle, group, did)
          : await revokeAuthorization(handle, group, did);
      process.stdout.write(
        `${cmd === 'autofile-grant' ? 'Granted' : 'Revoked'} autofile trust ${ok ? '✓' : '(no change)'}\n  emissary: ${did.slice(0, 32)}…\n` +
          (cmd === 'autofile-grant' ? '  → this Emissary’s submissions now auto-file (bypass quarantine).\n' : '  → this Emissary’s submissions now quarantine until you confirm.\n'),
      );
      break;
    }
    case 'change-registry': {
      // Move the Warden IDENTITY's registration to another registry — SAME DID, SAME keys, the sealed vault
      // untouched. This is NOT a rotation and NOT a rebuild. Needed to make a member-gated KB's Warden
      // publicly resolvable (a login challenge's controller is the Warden; a `local` Warden is notFound on
      // other nodes, so remote members can't verify the challenge). Groups stay wherever they were created.
      const registry = process.argv[3];
      if (!registry) throw new Error('usage: warden change-registry <registry>   (e.g. hyperswarm)');
      const id = await ensureIdentity(handle, config);
      // A DID BORN `local` cannot be migrated to a public registry through this path. `updateDID` queues the
      // migration op under the identity's CURRENT registry (`local`), and `queueOperation` drops local ops
      // ("don't distribute local DIDs") — so the move relabels the document LOCALLY, reports success, and the
      // DID never reaches another node (measured live 2026-08-29: the moved Warden was `notFound` on public
      // gatekeepers, its whole op chain still `event.registry=local`). Refuse loudly rather than lie.
      const curReg = ((await handle.keymaster.resolveDID(id.did, { confirm: false }).catch(() => undefined)) as
        | { didDocumentRegistration?: { registry?: string } }
        | undefined)?.didDocumentRegistration?.registry;
      if (curReg === 'local' && registry !== 'local') {
        throw new Error(
          `refusing: this Warden is born on \`local\`, and change-registry cannot PUBLISH a local-born DID — the ` +
            `migration op queues on \`local\` and is dropped, so the DID stays node-only while reporting success. ` +
            `To make it public: rebuild the Warden born on \`${registry}\` (new DID + keys), or admin export/import ` +
            `its op chain onto a public node (dids/export → dids/import). See deploy/agentic/INSTALL-agentic.md.`,
        );
      }
      const km = handle.keymaster as unknown as { changeRegistry(idName: string, registry: string): Promise<boolean> };
      const ok = await km.changeRegistry(IDENTITY_NAME.warden, registry);
      if (!ok) throw new Error('changeRegistry returned false — nothing changed');
      if (registry !== 'local') await handle.gatekeeper.processEvents(); // drain onto the new (queuing) registry
      process.stdout.write(
        `Moved ${IDENTITY_NAME.warden} (${id.did.slice(0, 24)}…) to registry '${registry}' — SAME DID + keys, sealed vault untouched (NOT a rotation).\n` +
          `  Wait for it to CONFIRM on '${registry}' before relying on remote resolution — remote verification needs confirm:true.\n`,
      );
      break;
    }
    case 'rotate':
    case 'passphrase':
    case 'check': {
      // Incident response (L1): rotate the signing keys, re-encrypt the wallet under a new passphrase, or
      // health-check the wallet. `rotate` needs the current identity loaded first.
      if (cmd === 'rotate') await ensureIdentity(handle, config);
      const result = await runKeyMaintenance(handle, cmd, process.argv[3]);
      process.stdout.write(`${result}\n`);
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
