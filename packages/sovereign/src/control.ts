/**
 * `sovereign control` — the Signet Approver's backing daemon.
 *
 * Runs the real Sovereign: opens its wallet, serves the DIDComm mailbox, and gates every disclosure
 * through the `HttpGate` so a human approves in the browser (proof-of-human) before a proof is
 * presented. Pending approvals and the decision history are exposed over a localhost control API +
 * SSE stream the Signet Approver app drives.
 */

import {
  ensureIdentity,
  DidCommTransport,
  IDENTITY_NAME,
  startControlServer,
  type HearthholdConfig,
  type KeymasterHandle,
} from '@hearthold/core';
import type {
  SignetStatus,
  SignetSnapshot,
  ApprovalDecisionRequest,
} from '@hearthold/control-types';

import { makeSovereignHandler } from './handler.js';
import { HttpGate } from './http-gate.js';

export async function runSovereignControl(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  port: number,
): Promise<void> {
  if (!config.signetPin) {
    throw new Error('HEARTHOLD_SIGNET_PIN is required for control — it gates each disclosure');
  }
  const id = await ensureIdentity(handle, config);
  const gate = new HttpGate(config.signetPin);

  const transport = new DidCommTransport(handle, IDENTITY_NAME.sovereign, config.nodeUrl);
  await transport.ready();

  const status = (): SignetStatus => ({
    identity: { role: 'sovereign', name: id.name, did: id.did },
    nodeUrl: config.nodeUrl,
    serving: true,
    pendingCount: gate.pendingCount(),
  });

  const snapshot = (): SignetSnapshot => ({
    status: status(),
    pending: gate.listPending(),
    history: gate.listHistory(),
  });

  const server = startControlServer({
    port,
    routes: {
      'GET /api/status': () => ({ status: status() }),
      'GET /api/snapshot': () => snapshot(),
      'POST /api/approve': ({ body }) => {
        const { id: approvalId, approve, pin } = (body ?? {}) as ApprovalDecisionRequest;
        if (!approvalId) throw new Error('id is required');
        const r = gate.decide(approvalId, Boolean(approve), pin);
        return { id: approvalId, decision: r.decision };
      },
    },
    onListening: (p) =>
      process.stdout.write(
        `Signet control on http://127.0.0.1:${p}\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  DIDComm mailbox serving; approvals gate through the app. (Ctrl-C to stop)\n`,
      ),
  });
  gate.emit = server.emit;

  const stop = await transport.serve(makeSovereignHandler(handle, gate));
  const shutdown = (): void => {
    stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
