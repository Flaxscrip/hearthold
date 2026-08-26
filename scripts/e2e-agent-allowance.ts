/**
 * e2e: the AgentGate control-allowance — bounded self-approval + escalation to the human parent.
 *
 * Proves the four security properties of docs/agentgate-allowance.md against a LIVE Archon node, over real
 * DIDComm, with real parent-signed Ruleset chains resolved + governor-pinned:
 *
 *   (a) WITHIN-allowance self-approves — a control act named in the parent-signed `control.selfApprove`
 *       returns a proof-of-AGENT assertion (`method:'agent'`); the parent's Signet is NEVER contacted.
 *   (b) ABOVE-allowance escalates to the PARENT — an act not in the allowance routes to the parent's Signet
 *       (proof-of-HUMAN, `method:'pin'`, act proceeds); a parent decline (or timeout) ⇒ refused (null).
 *   (c) NO allowance ⇒ deny-by-default — with no `control` allowance bound, even a would-be self-approvable
 *       act escalates/denies; NOTHING self-approves.
 *   (d) A SELF-WIDENED allowance is refused — an allowance the AGENT signed itself does not verify against
 *       `expectedSigner: parentDid`, is treated as absent, and deny-by-default holds.
 *
 * The child's gate is wired EXACTLY as `sovereign/control.ts` wires it for a child agent (permit +
 * escalate over `tierForControlAct` / `bandForTier` / `approverForTier` / `requestActionApprovalOverDidComm`,
 * allowance resolved via `activeRuleset(..., { expectedSigner: parentDid })`). The parent's Signet is the
 * real `makeSovereignHandler` + `PinGate` answering `hearthold/kb-approval-request`.
 *
 * Run:  HEARTHOLD_PASSPHRASE=… HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *         npm run e2e:agent-allowance
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signRuleset,
  activeRuleset,
  tierForControlAct,
  bandForTier,
  approverForTier,
  requestActionApprovalOverDidComm,
  AuthzTier,
  DidCommTransport,
  IDENTITY_NAME,
  type KeymasterHandle,
  type HearthholdMessage,
  type Ruleset,
  type SignedRuleset,
  type ControlAllowance,
  type FamilyTopology,
  type HumanPresenceAssertion,
} from '@hearthold/core';
import { makeSovereignHandler } from '@hearthold/sovereign/handler';
import { AgentGate, type ApprovalContext, type ApprovalGate } from '@hearthold/sovereign/signet';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e-agent-allowance');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';
const PIN = '2468';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  // Short step-up timeouts so a decline/timeout case is quick; a live node is required for identities/assets.
  const config = { ...loadConfig(), dataRoot: DATA_ROOT, stepUpTimeoutMs: { factor1: 12_000, factor2: 12_000 } };
  process.stdout.write(`Hearthold AgentGate control-allowance e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision the human PARENT Sovereign and the AI-agent CHILD Sovereign');
  const parent: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE); // the human parent's Signet
  const child: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE); // the AI-agent child
  const parentId = await ensureIdentity(parent, config);
  const childId = await ensureIdentity(child, config);
  check('identities ready', parentId.did.startsWith('did:') && childId.did.startsWith('did:'));

  const topology: FamilyTopology = { agentDid: childId.did, parentDid: parentId.did };

  // The parent SIGNS a control-allowance Ruleset for the child: it may self-approve `grant-capability` (any
  // resource) and `mint-root-capability` only for resources under `did:cid:friendly`. Everything else escalates.
  step('PARENT signs a control-allowance Ruleset for the child (grant-capability; mint-root only for did:cid:friendly*)');
  const allowanceCaps: ControlAllowance = {
    selfApprove: [
      { action: 'grant-capability' },
      { action: 'mint-root-capability', resourcePrefix: 'did:cid:friendly' },
    ],
  };
  const rulesetBody: Ruleset = {
    actor: childId.did,
    actorKind: 'sovereign',
    version: 1,
    previous: null,
    capabilities: { control: allowanceCaps },
    ceiling: 0,
    status: 'active',
  };
  const parentSigned = await signRuleset(parent, rulesetBody);
  const allowanceAsset = await parent.keymaster.createAsset([parentSigned], { registry: config.registry });
  check('parent-signed control-allowance anchored as an asset', typeof allowanceAsset === 'string' && allowanceAsset.startsWith('did:'));

  // A FORGED allowance: the CHILD signs the SAME body itself (a self-widening). It must NOT verify against
  // expectedSigner=parentDid, so it resolves to no allowance (deny-by-default).
  const childSigned = await signRuleset(child, rulesetBody);
  const forgedAsset = await child.keymaster.createAsset([childSigned], { registry: config.registry });

  // Publish endpoints once; the child only ever `request()`s, the parent `serve()`s per case.
  const childTransport = new DidCommTransport(child, IDENTITY_NAME.sovereign, config.nodeUrl);
  await childTransport.ready();
  await new DidCommTransport(parent, IDENTITY_NAME.warden, config.nodeUrl).ready();

  // ── The child's gate, wired EXACTLY as sovereign/control.ts wires a child agent ──────────────────────────
  const resolveAllowance = async (asset?: string): Promise<ControlAllowance | undefined> => {
    if (!asset) return undefined;
    const data = await child.keymaster.resolveAsset(asset).catch(() => null);
    const chain = Array.isArray(data) ? (data as SignedRuleset[]) : [];
    if (chain.length === 0) return undefined;
    const head = await activeRuleset(child, chain, { expectedSigner: parentId.did }).catch(() => null);
    return head?.capabilities.control;
  };
  const makeChildGate = (asset?: string): AgentGate => {
    const permit = async (ctx: ApprovalContext): Promise<boolean> => {
      const act = ctx.action ?? { action: 'unknown', resource: '' };
      return bandForTier(tierForControlAct(act, await resolveAllowance(asset))) !== 'parent';
    };
    const escalate = async (ctx: ApprovalContext): Promise<HumanPresenceAssertion | null> => {
      const act = ctx.action ?? { action: 'unknown', resource: '' };
      const tier = tierForControlAct(act, await resolveAllowance(asset));
      const approverDid = approverForTier(tier, topology);
      if (!approverDid) return { method: 'agent', level: 1, timestamp: new Date().toISOString() };
      const timeout = tier >= AuthzTier.HUMAN ? config.stepUpTimeoutMs.factor2 : config.stepUpTimeoutMs.factor1;
      const ok = await requestActionApprovalOverDidComm(
        childTransport,
        approverDid,
        { action: act.action, resource: act.resource ?? '', summary: ctx.action?.summary ?? '' },
        timeout,
      );
      return ok ? { method: 'pin', level: tier >= AuthzTier.MULTIFACTOR ? 2 : 1, timestamp: new Date().toISOString() } : null;
    };
    return new AgentGate(undefined, permit, escalate);
  };

  // The parent's real Signet over DIDComm — ONE long-lived reader (the mailbox is destructive; a second
  // overlapping reader would steal messages). `parentApproves` toggles approve/decline per case, and
  // `parentContacted` counts kb-approval-requests so "the parent was never contacted" is a hard assertion.
  let parentApproves = true;
  let parentContacted = 0;
  const parentGate: ApprovalGate = {
    approve: async () => (parentApproves ? { method: 'pin', level: 1, timestamp: new Date().toISOString() } : null),
  };
  const parentBase = makeSovereignHandler(parent, parentGate);
  const parentHandler = async (m: HearthholdMessage, from: string): Promise<HearthholdMessage | null> => {
    if (m.type === 'hearthold/kb-approval-request') parentContacted += 1;
    return parentBase(m, from);
  };
  const parentT = new DidCommTransport(parent, IDENTITY_NAME.warden, config.nodeUrl);
  const stopParent = await parentT.serve(parentHandler, { pollMs: 1000 });
  const arm = (approves: boolean): void => {
    parentApproves = approves;
    parentContacted = 0;
  };

  const grantAct = (resource: string): ApprovalContext => ({
    requester: 'the Table',
    action: { action: 'grant-capability', resource, summary: `grant a capability to ${resource}` },
  });
  const mintAct = (resource: string): ApprovalContext => ({
    requester: 'the Table',
    action: { action: 'mint-root-capability', resource, summary: `seed a root capability for ${resource}` },
  });

  // (a) WITHIN allowance ⇒ self-approves; parent never contacted. Parent stands ready to APPROVE, so if the
  //     act wrongly escalated we'd see method:'pin' and contacted>0 — either fails the assertions.
  step('(a) WITHIN allowance ⇒ the agent SELF-APPROVES (proof-of-agent), the parent is never contacted');
  arm(true);
  {
    const gate = makeChildGate(allowanceAsset);
    const a = await gate.approve(grantAct('did:cid:anyone')); // grant-capability, any resource ⇒ within
    check('grant-capability self-approves with method:agent', a?.method === 'agent' && a?.level === 1);
    const b = await gate.approve(mintAct('did:cid:friendly-child')); // mint-root under the allowed prefix ⇒ within
    check('mint-root within the allowed resource prefix self-approves (method:agent)', b?.method === 'agent');
    check('the parent Signet was NEVER contacted for within-allowance acts', parentContacted === 0);
  }

  // (b) ABOVE allowance ⇒ escalate to the parent. Approve → proof-of-human; decline → refused (fail-closed).
  step('(b) ABOVE allowance ⇒ escalate to the PARENT Signet');
  arm(true);
  {
    const gate = makeChildGate(allowanceAsset);
    const a = await gate.approve(mintAct('did:cid:stranger')); // mint-root OUTSIDE the allowed prefix ⇒ above
    check('parent APPROVES ⇒ proof-of-HUMAN (method:pin) and the act proceeds', a?.method === 'pin');
    check('the parent Signet was contacted for the above-allowance act', parentContacted >= 1);
  }
  arm(false);
  {
    const gate = makeChildGate(allowanceAsset);
    const a = await gate.approve(mintAct('did:cid:stranger'));
    check('parent DECLINES ⇒ refused (null), fail-closed', a === null);
    check('the parent Signet was still contacted (the escalation happened)', parentContacted >= 1);
  }

  // (c) NO allowance bound ⇒ deny-by-default: even grant-capability (self-approvable under the real allowance)
  //     now escalates and, with the parent declining, is refused — nothing self-approves.
  step('(c) NO allowance bound ⇒ deny-by-default: nothing self-approves');
  arm(false);
  {
    const gate = makeChildGate(undefined); // no control-allowance asset
    const a = await gate.approve(grantAct('did:cid:anyone'));
    check('grant-capability does NOT self-approve (no method:agent)', a?.method !== 'agent');
    check('it escalated (parent contacted) and, declined, is refused (null)', a === null && parentContacted >= 1);
  }

  // (d) A SELF-WIDENED allowance (child-signed) does not verify against the parent ⇒ treated as absent.
  step('(d) A SELF-SIGNED (widened) allowance is REFUSED — verified against parentDid, so it grants nothing');
  const forgedResolved = await resolveAllowance(forgedAsset);
  check('the child-signed allowance resolves to NOTHING (wrong signer, governor-pinned)', forgedResolved === undefined);
  arm(false);
  {
    const gate = makeChildGate(forgedAsset);
    const a = await gate.approve(grantAct('did:cid:anyone'));
    check('with a forged allowance, grant-capability does NOT self-approve', a?.method !== 'agent');
    check('it escalates and, declined, is refused (deny-by-default holds)', a === null && parentContacted >= 1);
  }

  stopParent();

  process.stdout.write(`\n${failures === 0 ? 'PASS — all four properties proven' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
  // The transport reader loops keep the process alive; exit explicitly on success/failure.
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 250).unref();
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e-agent-allowance error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
