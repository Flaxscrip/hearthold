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
  AuthzTier,
  PROTOCOL_VERSION,
  reconstructLineage,
  activeRuleset,
  tierForControlAct,
  bandForTier,
  approverForTier,
  requestActionApprovalOverDidComm,
  type HearthholdConfig,
  type KeymasterHandle,
  type WitnessKind,
  type RequestHandler,
  type HopRegisteredMessage,
  type HopRevokedMessage,
  type FlowEvent,
  type FlowEventMessage,
  type ActionApprovalRequestMessage,
  type ControlAllowance,
  type FamilyTopology,
  type SignedRuleset,
  type HumanPresenceAssertion,
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
import { type SignetGate, type ApprovalContext } from './signet.js';
import { buildAgentGate } from './agent-gate.js';
import { CapabilityGrantStore, grantCapability, mintRootGrant, revokeCapability, grantState, type CapabilityGrant } from './capability-grants.js';
import { LineageStore } from './lineage-store.js';

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

  // The transport is built FIRST — a child agent's AgentGate escalates over it to the parent's Signet.
  const transport = new DidCommTransport(handle, IDENTITY_NAME.sovereign, config.nodeUrl);
  await transport.ready();

  // Agent-family control-allowance (docs/agentgate-allowance.md). A CHILD agent (parentDid set) self-approves
  // ONLY the control acts its parent-signed allowance names; everything else escalates to the parent's Signet
  // (proof-of-human) or is refused (fail-closed). The ROOT agent (no parentDid) has no parent to escalate to —
  // it IS the root of authority — so its gate self-approves (permit/escalate stay unset, the prior behavior).
  const onAgentDecision = (ctx: ApprovalContext, approved: boolean): void => {
    process.stderr.write(
      `[agent-signet] ${approved ? 'approved' : 'refused'} ${ctx.action?.action ?? 'act'}${ctx.action?.summary ? ` — ${ctx.action.summary}` : ''}\n`,
    );
  };

  // The gate: a human PIN (HttpGate) or an AI agent's self-approval — built through the ONE shared wiring site
  // (agent-gate.ts) so THIS HTTP control surface and the `agent-signet` DIDComm daemon enforce IDENTICALLY. A
  // CHILD agent binds a real permit + escalate (bounded self-approval, escalate above); a ROOT agent self-approves.
  const agentBuild = agentMode ? await buildAgentGate(handle, config, id.did, transport, onAgentDecision) : null;
  const gate: SignetGate = agentBuild ? agentBuild.gate : new HttpGate(config.signetPin ?? '');

  // Boot posture — honest about what is enforced (docs/agentgate-allowance.md §"Honest UI becomes honest enforcement").
  let controlAllowanceSummary: SignetStatus['controlAllowance'];
  if (agentBuild?.isChild) {
    controlAllowanceSummary = {
      bound: agentBuild.bound,
      ...(config.parentDid ? { parentDid: config.parentDid } : {}),
      ...(agentBuild.allowance?.selfApprove ? { selfApprove: agentBuild.allowance.selfApprove } : {}),
    };
    if (agentBuild.bound) {
      const acts = (agentBuild.allowance?.selfApprove ?? [])
        .map((e) => e.action + (e.resourcePrefix ? `:${e.resourcePrefix}` : ''))
        .join(', ');
      process.stderr.write(
        `[sovereign] AGENT gate (child): a parent-signed control-allowance is BOUND and live-enforced — self-approves ` +
          `[${acts}]; every other control act escalates to the parent's Signet (proof-of-human) or is refused.\n`,
      );
    } else {
      process.stderr.write(
        `[sovereign] AGENT gate (child): DENY-BY-DEFAULT — no allowance bound (HEARTHOLD_CONTROL_ALLOWANCE_ASSET unset, ` +
          `unresolvable, or not signed by the parent). Self-approves NOTHING above standing; EVERY control act escalates ` +
          `to the parent's Signet. Bind a parent-signed control-allowance to grant self-authority.\n`,
      );
    }
  } else if (agentMode) {
    process.stderr.write(
      `[sovereign] AGENT gate (ROOT): no parent to escalate to — this control surface SELF-APPROVES every act (mint-root, ` +
        `authorize-capability, grants, revoke) with NO human PIN. Correct only for a ROOT agent Sovereign over its own ` +
        `domain; a CHILD agent must set HEARTHOLD_PARENT_DID + a parent-signed control-allowance so above-scope acts escalate.\n`,
    );
  }

  const grants = new CapabilityGrantStore(handle.dataFolder);
  const lineage = new LineageStore(handle.dataFolder);
  // The A2A flow log the Sovereign watches — a bounded live ring (recent-first via the route). In memory: it's a
  // live stream, not durable state (the lineage forest is the durable record).
  const flowLog: FlowEvent[] = [];

  const status = (): SignetStatus => ({
    identity: { role: 'sovereign', name: id.name, did: id.did },
    nodeUrl: config.nodeUrl,
    serving: true,
    pendingCount: gate.pendingCount(),
    gateMode: config.gateMode,
    ...(controlAllowanceSummary ? { controlAllowance: controlAllowanceSummary } : {}),
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
        await lineage.record({ vcDid: record.credentialDid, parentVcDid: null, issuer: id.did, holder: record.holder, counter: 0, ts: new Date().toISOString() });
        server.emit('root-minted', { rootVcDid: record.credentialDid, holder: record.holder });
        server.emit('lineage', { event: 'root-minted', vcDid: record.credentialDid, holder: record.holder });
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
        // Signet-gated like its authority-mutating siblings (authorize-capability, mint-root) — revocation is a
        // household-wide kill switch; it must not be a bare unauthenticated POST (audit-5). Human: PIN; AI-agent
        // Sovereign: AgentGate self-approves within the allowance.
        const g = await grants.get(credentialDid);
        const assertion = await gate.approve({
          requester: 'the Table',
          action: { action: 'revoke-capability', resource: credentialDid, summary: `Revoke the capability held by ${g?.holder ?? credentialDid} — the holder is cut at its next invocation` },
        });
        if (!assertion) return { revoked: false, reason: 'declined at the Signet' };
        const r = await revokeCapability(handle, id.name, grants, credentialDid);
        if (r.revoked) server.emit('capability-revoked', { credentialDid });
        return r;
      },

      // The WATCH (item 5): the live delegation forest I govern — roots I minted + hops the family's Emissaries
      // reported, each with its holder, depth, and revoked state. Provenance only; the SSE 'lineage' stream
      // pushes mint/delegate/revoke live. The Table renders the tree.
      'GET /api/lineage': async () => ({ forest: await lineage.forest() }),

      // Independently VERIFY a reported leaf against the PUBLIC chain (zero decryption) — reconstruct its lineage
      // by resolution and confirm the structure. A registration is a hint; this is the proof.
      'POST /api/reconstruct-lineage': async ({ body }) => {
        const { leafVcDid } = (body ?? {}) as { leafVcDid?: string };
        if (!leafVcDid) throw new Error('leafVcDid is required');
        return { lineage: await reconstructLineage(handle, leafVcDid) };
      },

      // The A2A flow watch: recent capability-exercise events across the family — who → whom, under what
      // authority, and the outcome (never the disclosed content). The SSE 'flow' stream pushes them live.
      'GET /api/flow': async () => ({ flow: [...flowLog].reverse().slice(0, 100) }),
    },
    onListening: (p) =>
      process.stdout.write(
        `Signet control on http://${config.controlHost}:${p}\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  DIDComm mailbox serving; approvals gate through the app. (Ctrl-C to stop)\n`,
      ),
  });
  gate.emit = server.emit;

  // Intercept the family's WATCH reports (fire-and-forget, return null) before the base handler: an Emissary
  // registers a hop it delegated / revoked, and we fold it into the live lineage forest + push an SSE event.
  const baseHandler = makeSovereignHandler(handle, gate, reopen, config.wardenDid);
  const handler: RequestHandler = async (message, fromDid) => {
    if (message.type === 'hearthold/hop-registered') {
      const m = message as HopRegisteredMessage;
      await lineage.record({ vcDid: m.childVcDid, parentVcDid: m.parentVcDid || null, issuer: fromDid, holder: m.holder, counter: m.counter, ts: new Date().toISOString() });
      server.emit('lineage', { event: 'delegated', childVcDid: m.childVcDid, parentVcDid: m.parentVcDid, holder: m.holder, from: fromDid });
      return null;
    }
    if (message.type === 'hearthold/hop-revoked') {
      const m = message as HopRevokedMessage;
      // Only the hop's ISSUER (the delegator who can actually cut it) or this governing Sovereign may mark it
      // revoked in the watch — else any DID reaching the mailbox could paint the kill-switch dashboard green on
      // a hop that is still live (audit-5). Fail-safe: an unauthorized report is ignored, not applied.
      const node = await lineage.get(m.childVcDid);
      if (node && (fromDid === node.issuer || fromDid === id.did)) {
        await lineage.markRevoked(m.childVcDid);
        server.emit('lineage', { event: 'revoked', childVcDid: m.childVcDid, from: fromDid });
      }
      return null;
    }
    if (message.type === 'hearthold/flow-event') {
      const m = message as FlowEventMessage;
      // The authcrypt sender is authoritative — a reporter cannot claim a different `from`.
      const flow = { ...m.flow, from: fromDid };
      flowLog.push(flow);
      if (flowLog.length > 200) flowLog.shift();
      server.emit('flow', { flow });
      return null;
    }
    if (message.type === 'hearthold/action-approval-request') {
      // A family agent asks to co-sign an authority-mutating act (delegate / revoke a hop) before performing it.
      // The gate decides — a human PINs, an AI-agent Sovereign's AgentGate self-approves within its allowance.
      const m = message as ActionApprovalRequestMessage;
      const assertion = await gate.approve({ requester: fromDid, action: m.action });
      return { type: 'hearthold/action-approval-response', version: PROTOCOL_VERSION, approved: !!assertion };
    }
    return baseHandler(message, fromDid);
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
