/**
 * e2e (Phase 2): the configurable CGPR autonomy threshold — CGPR as invocation at the edge.
 *
 * A disclosure at or below `cgprAutonomousAtOrBelow` clears autonomously (no per-request Signet consent);
 * above it, the gateway steps up to the Sovereign's Signet. The knob is CGPR-specific and defaults to LOW —
 * stricter than the internal `requiresHumanAt` — and is fully configurable (tighten OR loosen).
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-cgpr-threshold.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signRuleset,
  PROTOCOL_VERSION,
  Sensitivity,
  type Ruleset,
  type ApprovalRequestMessage,
  type ApprovalResponseMessage,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { CgprService } from '@hearthold/warden/cgpr';
import { FilePairwiseStore } from '@hearthold/warden/pairwise-store';
import type { SovereignApprover } from '@hearthold/warden/evidence';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-cgpr-threshold-e2e';
  const now = new Date().toISOString();

  const sovereign = await openKeymaster('sovereign', config, pass);
  const counterparty = await openKeymaster('verifier', config, pass);
  const sovId = await ensureIdentity(sovereign, config);
  const cId = await ensureIdentity(counterparty, config);

  // The gateway actor's Sovereign-signed Ruleset: may 'grant' on 'document' up to SEALED (so authorization is
  // never the thing under test — only the autonomy threshold is).
  const gwRuleset: Ruleset = { actor: 'a2a-gateway', actorKind: 'gateway', version: 1, previous: null, capabilities: { verbs: ['grant'], kinds: ['document'] }, ceiling: Sensitivity.SEALED, status: 'active' };
  const chain = [await signRuleset(sovereign, gwRuleset)];

  const wardenWith = async (sensitivity: Sensitivity, tag: string): Promise<Awaited<ReturnType<typeof openKeymaster>>> => {
    const cfg = { ...config, dataRoot: `${config.dataRoot}/${tag}` };
    const w = await openKeymaster('warden', cfg, pass);
    await ensureIdentity(w, cfg);
    await new VaultStore(w.dataFolder).put({ id: 'pref', kind: 'document', observedAt: now, storedAt: now, sensitivity, ciphertext: '(sealed)', metadata: { witness: cId.did }, owner: sovId.did });
    return w;
  };
  const wardenLow = await wardenWith(Sensitivity.LOW, 'low');
  const wardenMed = await wardenWith(Sensitivity.MEDIUM, 'med');

  let approverCalls = 0;
  const decliningApprover: SovereignApprover = {
    requestApproval: async (_req: ApprovalRequestMessage): Promise<ApprovalResponseMessage> => {
      approverCalls++;
      return { type: 'hearthold/approval-response', version: PROTOCOL_VERSION, approved: false, reason: 'declined by test' };
    },
  };

  const svc = (w: typeof wardenLow, threshold: Sensitivity, withApprover: boolean): CgprService =>
    new CgprService(w, { ...config, sovereignDid: sovId.did, cgprAutonomousAtOrBelow: threshold }, {
      gatewayRuleset: chain,
      sovereignDid: sovId.did,
      pairwiseStore: new FilePairwiseStore(w),
      kind: 'document',
      ...(withApprover ? { approver: decliningApprover } : {}),
    });
  const req = { audience: cId.did, scopes: ['foodAndBeverage.dietaryRestrictions'], purpose: 'menu personalization', validForMinutes: 10 };

  line('\n════ the CGPR autonomy threshold ════');

  // LOW ≤ LOW (default) → autonomous, no approver touched.
  approverCalls = 0;
  const a = await svc(wardenLow, Sensitivity.LOW, true).handle(req);
  check('LOW disclosure, threshold LOW → GRANTED autonomously (no Signet)', a.status === 'granted' && approverCalls === 0, `${a.status}/calls=${approverCalls}`);

  // MEDIUM > LOW (default) → steps up; with a declining Signet → denied.
  approverCalls = 0;
  const b = await svc(wardenMed, Sensitivity.LOW, true).handle(req);
  check('MEDIUM disclosure, threshold LOW → steps up to the Signet → DENIED on decline', b.status === 'denied' && approverCalls === 1, `${b.status}/calls=${approverCalls}`);

  // MEDIUM > LOW, no approver wired → fail closed (no autonomous MEDIUM).
  const c = await svc(wardenMed, Sensitivity.LOW, false).handle(req);
  check('MEDIUM disclosure, threshold LOW, no Signet channel → DENIED (fail closed)', c.status === 'denied', c.status === 'denied' ? c.reason : '');

  // Knob LOOSENED: MEDIUM ≤ MEDIUM → autonomous.
  approverCalls = 0;
  const d = await svc(wardenMed, Sensitivity.MEDIUM, true).handle(req);
  check('MEDIUM disclosure, threshold MEDIUM → GRANTED autonomously (knob loosened)', d.status === 'granted' && approverCalls === 0, `${d.status}/calls=${approverCalls}`);

  // Knob TIGHTENED: LOW > PUBLIC → steps up.
  approverCalls = 0;
  const e = await svc(wardenLow, Sensitivity.PUBLIC, true).handle(req);
  check('LOW disclosure, threshold PUBLIC → steps up to the Signet (knob tightened)', e.status === 'denied' && approverCalls === 1, `${e.status}/calls=${approverCalls}`);

  line(`\n${failures === 0 ? '✅ ALL PASS — the CGPR autonomy threshold is configurable both ways' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
