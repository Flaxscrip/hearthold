/**
 * Pure assembly of a Signet's status shape — the `controlAllowance` summary and the agent-signet's full
 * `SignetStatus`. Kept in its OWN module with TYPE-ONLY imports (no `AgentGate` class, no parameter-property
 * TS) so the security-relevant status a Table reads is unit-testable in isolation, and so the HTTP control
 * surface (`runSovereignControl`) and the `agent-signet` DIDComm daemon share ONE construction — the same
 * "both paths must agree" discipline `buildAgentGate` enforces for the gate itself.
 */
import type { HearthholdConfig } from '@hearthold/core';
import type { SignetStatus } from '@hearthold/control-types';

import type { AgentGateBuild } from './agent-gate.js';

/**
 * The `controlAllowance` summary. Undefined for a human gate or a ROOT agent (no bound allowance — the root
 * self-approves); a CHILD reports its bound flag, its parent, and the acts it may self-approve.
 */
export function agentControlAllowanceSummary(
  build: AgentGateBuild | null,
  config: HearthholdConfig,
): SignetStatus['controlAllowance'] {
  if (!build || !build.isChild) return undefined;
  return {
    bound: build.bound,
    ...(config.parentDid ? { parentDid: config.parentDid } : {}),
    ...(build.allowance?.selfApprove ? { selfApprove: build.allowance.selfApprove } : {}),
  };
}

/**
 * The `SignetStatus` an `agent-signet` publishes on its read-only `GET /api/status` — always
 * `gateMode:'agent'` (definitional for an agent gate) plus the shared allowance summary. A Table binds this
 * to `sovereignDid` by DID-equality (control-types COMPOSITION RULE) and reads gate posture from it.
 */
export function agentSignetStatus(
  identity: { name: string; did: string },
  config: HearthholdConfig,
  build: AgentGateBuild,
): SignetStatus {
  const controlAllowance = agentControlAllowanceSummary(build, config);
  return {
    identity: { role: 'sovereign', name: identity.name, did: identity.did },
    nodeUrl: config.nodeUrl,
    serving: true,
    pendingCount: build.gate.pendingCount(),
    gateMode: 'agent',
    ...(controlAllowance ? { controlAllowance } : {}),
  };
}
