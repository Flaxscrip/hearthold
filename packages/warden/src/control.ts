/**
 * `warden control` — the Warden Console's backing daemon.
 *
 * Runs the real Warden: opens its wallet, serves the DIDComm mailbox (store submissions, reply with
 * receipts), and exposes a localhost control API + SSE event stream the browser console drives. Every
 * stored submission is pushed to connected consoles live.
 */

import {
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  DidCommTransport,
  IDENTITY_NAME,
  startControlServer,
  type HearthholdConfig,
  type KeymasterHandle,
  type RequestHandler,
  type SubmissionReceipt,
  type WitnessSubmission,
} from '@hearthold/core';
import {
  SENSITIVITY_NAMES,
  type SensitivityName,
  type VaultItem,
  type WardenSnapshot,
  type WardenStatus,
  type DelegateRequest,
  type ClassifyRequest,
} from '@hearthold/control-types';

import { createClassifier } from './classifier.js';
import { WardenService } from './service.js';
import { VaultStore, type Artefact } from './store.js';
import { DelegationStore } from './delegations.js';
import { EvidenceService } from './evidence.js';
import { makeWardenHandler } from './handler.js';

const sensitivityName = (s: number): SensitivityName => SENSITIVITY_NAMES[s] ?? 'SEALED';

const toVaultItem = (a: Artefact): VaultItem => ({
  id: a.id,
  kind: a.kind,
  sensitivity: a.sensitivity,
  sensitivityName: sensitivityName(a.sensitivity),
  observedAt: a.observedAt,
});

export async function runWardenControl(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  port: number,
): Promise<void> {
  const id = await ensureIdentity(handle, config);
  const store = new VaultStore(handle.dataFolder);
  const delegations = new DelegationStore(handle);
  const service = new WardenService(handle, createClassifier(config));

  const transport = new DidCommTransport(handle, IDENTITY_NAME.warden, config.nodeUrl);
  await transport.ready();

  const classifierLabel =
    config.classifierMode === 'ollama'
      ? `ollama ${config.classifierModel} @ ${config.ollamaUrl}`
      : 'quarantine (model disabled)';

  const status = async (): Promise<WardenStatus> => ({
    identity: { role: 'warden', name: id.name, did: id.did },
    nodeUrl: config.nodeUrl,
    dataFolder: handle.dataFolder,
    classifier: classifierLabel,
    artefactCount: (await store.list()).length,
    delegationCount: (await delegations.list()).length,
    serving: true,
  });

  const snapshot = async (): Promise<WardenSnapshot> => ({
    status: await status(),
    vault: (await store.list()).map(toVaultItem),
    delegations: await delegations.list(),
  });

  const server = startControlServer({
    port,
    routes: {
      'GET /api/status': async () => ({ status: await status() }),
      'GET /api/snapshot': async () => await snapshot(),
      'POST /api/delegate': async ({ body }) => {
        const { witnessDid } = (body ?? {}) as DelegateRequest;
        if (!witnessDid) throw new Error('witnessDid is required');
        const schemaDid = await ensureDelegationSchema(handle);
        const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
        const credentialDid = await issueDelegation(handle, witnessDid, schemaDid, {
          kinds: ['event', 'location', 'activity', 'browsing', 'document'],
          validUntil,
        });
        await delegations.record(witnessDid, credentialDid);
        server.emit('delegation-issued', { subjectDid: witnessDid, credentialDid });
        return { subjectDid: witnessDid, credentialDid };
      },
      'POST /api/classify': async ({ body }) => {
        const { kind, text } = (body ?? {}) as ClassifyRequest;
        if (!kind || !text) throw new Error('kind and text are required');
        const r = await createClassifier(config).classify({ kind, text });
        return {
          sensitivity: r.sensitivity,
          sensitivityName: sensitivityName(r.sensitivity),
          tags: (r.metadata.tags as string[] | undefined) ?? [],
          reason: (r.metadata.reason as string | undefined) ?? (r.metadata.error as string) ?? '',
          needsHumanConfirmation: r.needsHumanConfirmation,
        };
      },
    },
    onListening: (p) =>
      process.stdout.write(
        `Warden control on http://127.0.0.1:${p}\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  DIDComm mailbox serving; console API live. (Ctrl-C to stop)\n`,
      ),
  });

  // Wrap the real handler so a stored submission is pushed to connected consoles.
  const inner = makeWardenHandler(service, delegations, new EvidenceService(handle, config));
  const handler: RequestHandler = async (message, fromDid) => {
    const result = await inner(message, fromDid);
    if (
      result &&
      (result as { type?: string }).type === 'hearthold/submission-receipt' &&
      message.type === 'hearthold/witness-submission'
    ) {
      const receipt = result as SubmissionReceipt;
      const sub = message as WitnessSubmission;
      const item: VaultItem = {
        id: receipt.artefactId,
        kind: sub.kind,
        sensitivity: receipt.assignedSensitivity,
        sensitivityName: sensitivityName(receipt.assignedSensitivity),
        observedAt: sub.observedAt,
      };
      server.emit('submission-stored', { item, from: fromDid });
    }
    return result;
  };

  const stop = await transport.serve(handler);
  const shutdown = (): void => {
    stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
