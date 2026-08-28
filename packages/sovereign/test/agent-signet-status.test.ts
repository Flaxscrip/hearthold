/**
 * Unit tests for the agent-signet's read-only status assembly (`src/agent-gate.ts`). The Table reads this to
 * render an agent Sovereign's gate posture, so it must never drift from the human control surface and must be
 * honest about root vs child/bound. Pure — a fresh `AgentGate` fixture, no node, no keymaster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import from the TYPE-ONLY status module (not agent-gate) so this runs under strip-types without loading the
// AgentGate class (whose file uses parameter properties). A stub gate is all the assembler needs.
import { agentControlAllowanceSummary, agentSignetStatus } from '../src/signet-status.ts';

const stubGate = { pendingCount: () => 0 };
type Build = { gate: typeof stubGate; isChild: boolean; bound: boolean; allowance?: { selfApprove?: unknown[] } };
// The functions read only gate.pendingCount + isChild/bound/allowance + nodeUrl/parentDid; casts keep it small.
const cfg = (parentDid?: string): never => ({ nodeUrl: 'http://node.test', parentDid } as unknown as never);
const build = (b: Build): never => b as unknown as never;
const id = { name: 'sovereign', did: 'did:cid:self' };

const rootBuild = build({ gate: stubGate, isChild: false, bound: false });
const childBound = build({
  gate: stubGate,
  isChild: true,
  bound: true,
  allowance: { selfApprove: [{ action: 'mint-root' }, { action: 'grant', resourcePrefix: 'hearthold:vault' }] },
});
const childUnbound = build({ gate: stubGate, isChild: true, bound: false });

test('allowance summary: a ROOT agent has none (self-approves, nothing bound)', () => {
  assert.equal(agentControlAllowanceSummary(rootBuild, cfg('did:cid:parent')), undefined);
});

test('allowance summary: null build (human gate) → undefined', () => {
  assert.equal(agentControlAllowanceSummary(null, cfg()), undefined);
});

test('allowance summary: a BOUND child reports bound + parent + self-approvable acts', () => {
  assert.deepEqual(agentControlAllowanceSummary(childBound, cfg('did:cid:parent')), {
    bound: true,
    parentDid: 'did:cid:parent',
    selfApprove: [{ action: 'mint-root' }, { action: 'grant', resourcePrefix: 'hearthold:vault' }],
  });
});

test('allowance summary: an UNBOUND child reports bound:false (deny-by-default), no selfApprove', () => {
  assert.deepEqual(agentControlAllowanceSummary(childUnbound, cfg('did:cid:parent')), {
    bound: false,
    parentDid: 'did:cid:parent',
  });
});

test('status: gateMode is ALWAYS "agent" (definitional for an agent-signet), whatever the build', () => {
  for (const build of [rootBuild, childBound, childUnbound]) {
    assert.equal(agentSignetStatus(id, cfg('did:cid:parent'), build).gateMode, 'agent');
  }
});

test('status: a ROOT agent-signet omits controlAllowance (nothing bound)', () => {
  const s = agentSignetStatus(id, cfg(), rootBuild);
  assert.equal(s.controlAllowance, undefined);
  assert.deepEqual(s.identity, { role: 'sovereign', name: 'sovereign', did: 'did:cid:self' });
  assert.equal(s.serving, true);
  assert.equal(s.nodeUrl, 'http://node.test');
  assert.equal(typeof s.pendingCount, 'number');
});

test('status: a BOUND child-signet carries its controlAllowance', () => {
  const s = agentSignetStatus(id, cfg('did:cid:parent'), childBound);
  assert.equal(s.controlAllowance?.bound, true);
  assert.equal(s.controlAllowance?.parentDid, 'did:cid:parent');
});
