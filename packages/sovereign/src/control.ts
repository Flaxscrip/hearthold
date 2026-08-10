/**
 * `sovereign control` — the Signet Approver's backing daemon.
 *
 * Runs the real Sovereign: opens its wallet, serves the DIDComm mailbox, and gates every disclosure
 * through the `HttpGate` so a human approves in the browser (proof-of-human) before a proof is
 * presented. Pending approvals and the decision history are exposed over a localhost control API +
 * SSE stream the Signet Approver app drives.
 */

import { randomUUID } from 'node:crypto';

import {
  ensureIdentity,
  DidCommTransport,
  IDENTITY_NAME,
  startControlServer,
  Sensitivity,
  PROTOCOL_VERSION,
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
  CapabilitiesResponse,
  CapabilityGrantView,
  RevokeCapabilityRequest,
  RevokeCapabilityResponse,
  MintRootRequest,
  MintRootResponse,
} from '@hearthold/control-types';

import { makeSovereignHandler } from './handler.js';
import { HttpGate } from './http-gate.js';
import { AgentGate, type SignetGate } from './signet.js';
import { CapabilityGrantStore, grantCapability, mintRootGrant, revokeCapability, grantState, type CapabilityGrant } from './capability-grants.js';

export async function runSovereignControl(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  port: number,
  reopen?: () => Promise<KeymasterHandle>,
): Promise<void> {
  const agentMode = config.gateMode === 'agent';
  if (!agentMode && !config.signetPin) {
    throw new Error('HEARTHOLD_SIGNET_PIN is required for control in human mode — it gates each disclosure (or set HEARTHOLD_GATE_MODE=agent for an AI-agent Sovereign that self-approves within its allowance)');
  }
  const id = await ensureIdentity(handle, config);
  // The gate: a human PIN (HttpGate) or an AI agent's self-approval within its parent-signed allowance
  // (AgentGate — no PIN, receipts). Both satisfy SignetGate, so the routes + status/snapshot are identical.
  const gate: SignetGate = agentMode
    ? new AgentGate((ctx, approved) => {
        process.stderr.write(`[agent-signet] ${approved ? 'self-approved' : 'refused'} ${ctx.action?.action ?? 'act'}${ctx.action?.summary ? ` — ${ctx.action.summary}` : ''}\n`);
      })
    : new HttpGate(config.signetPin ?? '');
  if (agentMode) {
    // Honest posture: with no allowance predicate bound (AgentGate.permit), this SELF-APPROVES every control act
    // — mint-root, authorize-capability, disclosures — with no human PIN. "Within the parent-signed allowance"
    // is the DESIGN; the enforcing predicate is a seam (bind a signed-Ruleset allowance) not yet wired. Escalation
    // above scope is the Warden's ladder (for disclosures), not the local control routes. Warn so an operator
    // doesn't mistake opt-in agent autonomy for a bounded allowance.
    process.stderr.write(
      `[sovereign] AGENT gate: this control surface SELF-APPROVES every act (mint-root, authorize-capability, ` +
        `disclosures) with NO human PIN, and the parent-signed allowance is NOT yet enforced (AgentGate.permit ` +
        `unset). Use only for an AI-agent Sovereign over its own domain; bind a signed-Ruleset allowance before ` +
        `a production agent self-grants high-authority acts.\n`,
    );
  }
  const grants = new CapabilityGrantStore(handle.dataFolder);

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

        // Recorded in the inventory so it can be listed + revoked (Phase 4).
        const grant = await grantCapability(handle, id.name, id.did, config, { holder: req.emissaryDid, target, ...(kinds ? { kinds } : {}), ceiling, days }, grants);
        server.emit('capability-granted', { credentialDid: grant.credentialDid, holder: grant.holder });
        return { granted: true, credentialDid: grant.credentialDid, schemaDid: grant.schemaDid };
      },

      // Seed an agent's Emissary with a ROOT chain-capability (the family root of authority) and hand it over
      // DIDComm, so the agent can invoke AND delegate onward. Signet-gated — the human authorizes creating a new
      // root of authority for an agent. Recorded so it lists + revokes like any grant (revoke = cut the agent).
      'POST /api/mint-root': async ({ body }): Promise<MintRootResponse> => {
        const req = (body ?? {}) as MintRootRequest;
        if (!req.emissaryDid) throw new Error('emissaryDid is required');
        const CEIL: Record<string, Sensitivity> = { PUBLIC: Sensitivity.PUBLIC, LOW: Sensitivity.LOW, MEDIUM: Sensitivity.MEDIUM, HIGH: Sensitivity.HIGH, SEALED: Sensitivity.SEALED };
        const ceilingLabel = (req.ceiling ?? 'MEDIUM').toUpperCase();
        const ceiling = CEIL[ceilingLabel];
        if (ceiling === undefined) throw new Error(`unknown ceiling '${req.ceiling}' — use PUBLIC|LOW|MEDIUM|HIGH|SEALED`);
        const target = req.target ?? 'hearthold:vault';
        const kinds = req.kinds && req.kinds.length > 0 ? (req.kinds as WitnessKind[]) : undefined;

        const assertion = await gate.approve({
          requester: 'the Table',
          action: {
            action: 'mint-root-capability',
            resource: req.emissaryDid,
            summary: `Seed this agent's Emissary with a ROOT capability over ${target} to PROVE ${kinds ? kinds.join('/') : 'any'} facts ≤ ${ceilingLabel} (it may then delegate onward)`,
          },
        });
        if (!assertion) return { minted: false, declined: true };

        const { grant, record } = await mintRootGrant(handle, id.name, id.did, config, { holder: req.emissaryDid, target, ...(kinds ? { kinds } : {}), ceiling }, grants);
        // Hand the root to the agent's Emissary over DIDComm (fire-and-forget; it persists on its next poll).
        await handle.keymaster.sendDidComm(
          { type: 'hearthold/chain-grant', thid: randomUUID(), body: { type: 'hearthold/chain-grant', version: PROTOCOL_VERSION, grant } },
          req.emissaryDid,
          { name: id.name },
        );
        server.emit('root-minted', { rootVcDid: record.credentialDid, holder: record.holder });
        return { minted: true, rootVcDid: record.credentialDid, holder: record.holder };
      },

      // The permissions center: list the capabilities the Sovereign has granted (the Table mirrors this
      // read-only), and revoke one — which flips its status bit so the Warden refuses it at the next invocation.
      'GET /api/capabilities': async (): Promise<CapabilitiesResponse> => {
        const list = await grants.list();
        const view = (g: CapabilityGrant): CapabilityGrantView => ({
          credentialDid: g.credentialDid,
          holder: g.holder,
          target: g.target,
          ...(g.kinds ? { kinds: g.kinds } : {}),
          ceiling: g.ceiling,
          expires: g.expires,
          issuedAt: g.issuedAt,
          state: grantState(g),
          ...(g.revokedAt ? { revokedAt: g.revokedAt } : {}),
        });
        return { capabilities: list.map(view) };
      },
      'POST /api/revoke-capability': async ({ body }): Promise<RevokeCapabilityResponse> => {
        const { credentialDid } = (body ?? {}) as RevokeCapabilityRequest;
        if (!credentialDid) throw new Error('credentialDid is required');
        const r = await revokeCapability(handle, id.name, grants, credentialDid);
        if (r.revoked) server.emit('capability-revoked', { credentialDid });
        return r;
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
