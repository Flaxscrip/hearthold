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
  LoginSignRequest,
} from '@hearthold/control-types';

import { makeSovereignHandler } from './handler.js';
import { HttpGate } from './http-gate.js';

export async function runSovereignControl(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  port: number,
  reopen?: () => Promise<KeymasterHandle>,
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
    host: config.controlHost,
    routes: {
      'GET /api/status': () => ({ status: status() }),
      'GET /api/snapshot': () => snapshot(),
      'POST /api/approve': ({ body }) => {
        const { id: approvalId, approve, pin } = (body ?? {}) as ApprovalDecisionRequest;
        if (!approvalId) throw new Error('id is required');
        const r = gate.decide(approvalId, Boolean(approve), pin);
        return { id: approvalId, decision: r.decision };
      },

      // The Signet-brokered middle hop of control login. The browser relays the Warden's challenge here;
      // the Signet signs it — human-gated, keys never leaving — and returns the response DID to relay to
      // the Warden's `login/complete`. SECURITY HINGE: resolve the challenge and sign ONLY if its purpose
      // is `hearthold-control`; refuse anything else, so a compromised browser can request a login (the
      // human sees + PINs it) but cannot drive the Signet to `createResponse` an arbitrary challenge.
      'POST /api/login/sign': async ({ body }) => {
        const { challenge } = (body ?? {}) as LoginSignRequest;
        if (!challenge) throw new Error('challenge is required');
        const doc = await handle.keymaster.resolveDID(challenge).catch(() => null);
        const purpose = (doc?.didDocumentData as { challenge?: { purpose?: string } } | undefined)?.challenge?.purpose;
        if (purpose !== 'hearthold-control') {
          throw new Error(`refusing to sign: challenge purpose is '${purpose ?? 'unresolved'}', not 'hearthold-control'`);
        }
        // Human-gate exactly like the forge step-up — the member's Signet prompts (PIN) before signing.
        const assertion = await gate.approve({
          requester: 'control-login',
          action: { action: 'login-sign', resource: challenge, summary: 'Approve a control-plane login (sign the challenge)' },
        });
        if (!assertion) return { declined: true };
        // Sign in the Signet; the browser only relays the response DID. PVM intact — keys never leave.
        await handle.keymaster.setCurrentId(id.name);
        const response = await handle.keymaster.createResponse(challenge);
        return { response };
      },
    },
    onListening: (p) =>
      process.stdout.write(
        `Signet control on http://${config.controlHost}:${p}\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  DIDComm mailbox serving; approvals gate through the app. (Ctrl-C to stop)\n`,
      ),
  });
  gate.emit = server.emit;

  const stop = await transport.serve(makeSovereignHandler(handle, gate, reopen));
  const shutdown = (): void => {
    stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
