/**
 * Provision parent-signed control-allowances for the family agents — Part B of the governance rollout
 * (docs/provisioning-family-agents.md). Run AS THE NODE SOVEREIGN (the parent). For each agent it signs a
 * control-allowance Ruleset and anchors it as an asset; the resulting asset DID becomes that agent's
 * HEARTHOLD_CONTROL_ALLOWANCE_ASSET, which Aegis wires onto its `*-agent-signet` service (Part B step 2).
 *
 * SAFE + PARALLEL: this ONLY signs + anchors assets. It does NOT touch any deployed agent — the assets sit
 * unused until wired, so running it has zero effect on Track A or on Sevenfold's live render. A `--dry-run`
 * prints the exact ruleset bodies and signs nothing.
 *
 * GUARD: refuses to sign unless the current sovereign identity IS the node sovereign (`NODE_SOVEREIGN`).
 * An allowance signed by anyone else fails the agents' governor-pinned verification (deny-by-default), so
 * signing as the wrong identity would silently produce a useless asset — we fail loud instead.
 *
 * SCOPE: edit `AGENTS[].selfApprove` before a real run. Empty (the default) = deny-by-default — a governed
 * CHILD that self-approves nothing and escalates every control act to the node sovereign. Widen deliberately
 * per demonstrated need; each widening is a fresh run (a parent-signed supersession).
 *
 *   HEARTHOLD_PASSPHRASE=… npm run provision:agent-allowance -- --dry-run   # preview, signs nothing
 *   HEARTHOLD_PASSPHRASE=… npm run provision:agent-allowance                # sign + anchor (node-sovereign wallet)
 */
import {
  loadConfig,
  openKeymaster,
  passphraseFor,
  ensureIdentity,
  signRuleset,
  type Ruleset,
  type ControlAllowance,
} from '@hearthold/core';

/** The node sovereign (parent) that MUST sign these — the agents' governor-pinning reader checks this DID. */
const NODE_SOVEREIGN = 'did:cid:bagaaierayveej3vjjm4owqq2ialx7zew3lyhuqjph2mnydlbedh4sjij3ufa';

/**
 * Per-agent control-allowance scope. EMPTY = deny-by-default (recommended start). To grant self-authority,
 * add entries like `{ action: 'grant-capability', resourcePrefix: 'did:cid:…' }` — an act matches only when
 * its resource STARTS WITH `resourcePrefix` (omit the prefix for any resource of that action).
 */
const AGENTS: { name: string; sovereignDid: string; selfApprove: NonNullable<ControlAllowance['selfApprove']> }[] = [
  { name: 'sevenfold', sovereignDid: 'did:cid:bagaaieradstvn46cks6fgjeilmajyaorsgt3pnscjyq7h2jvo5bvkcl23vqq', selfApprove: [] },
  { name: 'hearthold', sovereignDid: 'did:cid:bagaaieral7gyx5p2nkkplnxe5vpinwgpgyzhgsb4ac24lm7vy33gyyx34jzq', selfApprove: [] },
  { name: 'aegis', sovereignDid: 'did:cid:bagaaiera4jcssav3sn7f2owztjgyzynv3k25p23mvfyhybvmfyl3hkltc4nq', selfApprove: [] },
];

function allowanceRuleset(agentDid: string, selfApprove: NonNullable<ControlAllowance['selfApprove']>): Ruleset {
  const control: ControlAllowance = { selfApprove };
  return {
    actor: agentDid,
    actorKind: 'sovereign',
    version: 1,
    previous: null,
    capabilities: { control },
    ceiling: 0,
    status: 'active',
  } as Ruleset;
}

const actsLabel = (selfApprove: NonNullable<ControlAllowance['selfApprove']>): string =>
  selfApprove.map((e) => e.action + (e.resourcePrefix ? `:${e.resourcePrefix}` : '')).join(', ') ||
  '(none — deny-by-default: every control act escalates to the node sovereign)';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const node = await openKeymaster('sovereign', config, passphraseFor('sovereign'));
  const nodeId = await ensureIdentity(node, config);

  process.stdout.write(`\n[provision] ${dryRun ? 'DRY-RUN — nothing will be signed' : 'LIVE — will sign + anchor assets'}\n`);
  process.stdout.write(`[provision] signing identity : ${nodeId.did} (${nodeId.name})\n`);
  process.stdout.write(`[provision] node sovereign   : ${NODE_SOVEREIGN}\n`);

  const isNode = nodeId.did === NODE_SOVEREIGN;
  if (!isNode) {
    process.stdout.write('[provision] ⚠ current identity is NOT the node sovereign.\n');
    if (!dryRun) {
      process.stderr.write(
        `[provision] REFUSING to sign — an allowance not signed by ${NODE_SOVEREIGN} fails the agents' ` +
          `governor-pinned verification (deny-by-default), so it would be a useless asset. Run this as the ` +
          `node-sovereign wallet (its identity must be current).\n`,
      );
      process.exit(1);
    }
    process.stdout.write('[provision] (dry-run continues to show the ruleset bodies)\n');
  }

  const wiring: { name: string; asset: string }[] = [];
  for (const a of AGENTS) {
    const rs = allowanceRuleset(a.sovereignDid, a.selfApprove);
    process.stdout.write(`\n[provision] ${a.name}  (actor ${a.sovereignDid})\n  selfApprove: ${actsLabel(a.selfApprove)}\n`);
    if (dryRun) {
      process.stdout.write(`  ruleset: ${JSON.stringify(rs)}\n`);
      continue;
    }
    const signed = await signRuleset(node, rs);
    const asset = await node.keymaster.createAsset([signed], { registry: config.registry });
    process.stdout.write(`  → HEARTHOLD_CONTROL_ALLOWANCE_ASSET = ${asset}\n`);
    wiring.push({ name: a.name, asset });
  }

  if (dryRun) {
    process.stdout.write('\n[provision] dry-run complete — nothing signed or anchored.\n');
    return;
  }

  process.stdout.write('\n[provision] DONE. Hand these to Aegis (Part B step 2 — wire onto each signet):\n');
  for (const w of wiring) {
    process.stdout.write(
      `  ${w.name}-agent-signet:  HEARTHOLD_PARENT_DID=${NODE_SOVEREIGN}  HEARTHOLD_CONTROL_ALLOWANCE_ASSET=${w.asset}\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
