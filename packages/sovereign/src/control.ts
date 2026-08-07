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
  issueScopeCapability,
  ensureAuthorizationSchema,
  Sensitivity,
  type HearthholdConfig,
  type KeymasterHandle,
  type WitnessKind,
} from '@hearthold/core';
import type {
  SignetStatus,
  SignetSnapshot,
  ApprovalDecisionRequest,
  LoginSignRequest,
  AuthorizeCapabilityRequest,
  AuthorizeCapabilityResponse,
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
    allowOrigins: config.controlAllowOrigins,
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

      // Grant the Emissary a revocable scope capability to PROVE facts (the invocation grant). Signet-gated
      // so the human sees exactly what disclosure authority they authorize — separate from submit-delegation
      // by design. The Table drives this; the signature is the Sovereign's, here at the Signet.
      'POST /api/authorize-capability': async ({ body }): Promise<AuthorizeCapabilityResponse> => {
        const req = (body ?? {}) as AuthorizeCapabilityRequest;
        if (!req.emissaryDid) throw new Error('emissaryDid is required');
        const CEIL: Record<string, Sensitivity> = { PUBLIC: Sensitivity.PUBLIC, LOW: Sensitivity.LOW, MEDIUM: Sensitivity.MEDIUM, HIGH: Sensitivity.HIGH, SEALED: Sensitivity.SEALED };
        const ceilingLabel = (req.ceiling ?? 'LOW').toUpperCase();
        const ceiling = CEIL[ceilingLabel];
        if (ceiling === undefined) throw new Error(`unknown ceiling '${req.ceiling}' — use PUBLIC|LOW|MEDIUM|HIGH|SEALED`);
        const target = req.target ?? 'hearthold:vault';
        const kinds = req.kinds && req.kinds.length > 0 ? (req.kinds as WitnessKind[]) : undefined;
        const days = req.days ?? 90;
        const validUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

        const assertion = await gate.approve({
          requester: 'the Table',
          action: {
            action: 'grant-capability',
            resource: req.emissaryDid,
            summary: `Grant this Emissary a capability to PROVE ${kinds ? kinds.join('/') : 'any'} facts ≤ ${ceilingLabel}, expiring ${validUntil.slice(0, 10)}`,
          },
        });
        if (!assertion) return { granted: false, declined: true };

        const schemaDid = await ensureAuthorizationSchema(handle);
        const credentialDid = await issueScopeCapability({
          issuer: handle,
          issuerName: id.name,
          holder: req.emissaryDid,
          schemaDid,
          config,
          scope: {
            invocationTarget: target,
            authority: { operations: ['prove'], resources: [target] },
            caveats: { ceiling, owner: id.did, expires: validUntil, ...(kinds ? { kinds } : {}) },
          },
          validUntil,
        });
        return { granted: true, credentialDid, schemaDid };
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
