/**
 * Provision the node family — reproducible, idempotent.
 *
 * The node Sovereign (…ij3ufa = flaxscrip / the Table login) is the PARENT / governor. This creates the
 * three AI-agent identities — Aegis · Sevenfold · Hearthold — FRESH in the `node` environment's identity
 * store, each with a parent-SIGNED spend allowance. No demo parent, no duplicate id-names: the agents get
 * their own names, and the parent is the real Sovereign the Table logs in as.
 *
 * SAFETY: the parent is read via currentIdentity() (NO wallet mutation) and its data root is mounted
 * READ-ONLY by the runner. signRuleset = keymaster.addProof() — a pure in-memory signature over the
 * ruleset JSON; it neither writes the Sovereign wallet nor anchors an asset. Re-running reuses existing
 * agent ids and re-signs their rulesets.
 *
 *   ./deploy/family/provision-node-family.sh
 */
import {
  loadConfig, openKeymaster, ensureIdentity, currentIdentity, signRuleset, Sensitivity,
  type Ruleset, type SpendAllowance,
} from '@hearthold/core';
import { writeFileSync, mkdirSync } from 'node:fs';

const NODE_SOVEREIGN_DID = 'did:cid:bagaaierayveej3vjjm4owqq2ialx7zew3lyhuqjph2mnydlbedh4sjij3ufa';
const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };

// NOTE on id-naming: each agent lives in its OWN wallet dir (agents/<name>/), so we use the sovereign ROLE name
// (via ensureIdentity — the same name the Warden/agent-signet daemons expect) rather than the agent name. Naming
// an agent id 'hearthold' instead would make a bound `sovereign agent-signet` create a STRAY id and serve the
// wrong DID. The directory + DID disambiguate agents; the id-name is role-based for daemon compatibility.

async function main(): Promise<void> {
  const base = loadConfig();
  const parentRoot = need('PARENT_DATA_ROOT');
  const parentPass = need('PARENT_PASSPHRASE');
  const agentsRoot = need('AGENTS_DATA_ROOT');
  const agentPass = need('AGENT_PASSPHRASE');

  // PARENT = the node Sovereign …ij3ufa. Read-only: currentIdentity() never mutates the wallet.
  const parentKm = await openKeymaster('sovereign', { ...base, dataRoot: parentRoot }, parentPass);
  const parent = await currentIdentity(parentKm);
  if (!parent) throw new Error('parent wallet has no current id');
  if (parent.did !== NODE_SOVEREIGN_DID) {
    throw new Error(`parent is ${parent.did}, expected node Sovereign ${NODE_SOVEREIGN_DID} — refusing`);
  }
  process.stdout.write(`parent   flaxscrip / node-sovereign   ${parent.did}\n`);

  const AGENTS = [
    { name: 'aegis',     selfLimit: 2000 },
    { name: 'sevenfold', selfLimit: 2000 },
    { name: 'hearthold', selfLimit: 2000 },
  ];
  const roster: Record<string, unknown> = {
    env: 'node', parent: { role: 'flaxscrip', did: parent.did }, registry: base.registry, agents: {} as Record<string, unknown>,
  };

  for (const a of AGENTS) {
    const dir = `${agentsRoot}/${a.name}`;
    mkdirSync(dir, { recursive: true });
    const km = await openKeymaster('sovereign', { ...base, dataRoot: dir }, agentPass);
    const id = await ensureIdentity(km, { ...base, dataRoot: dir });   // role-name → daemon-compatible
    const allowance: SpendAllowance = { unit: 'sat', notifyAbove: 100, selfLimit: a.selfLimit, parentMultifactorAbove: 10000 };
    const ruleset: Ruleset = {
      actor: id.did, actorKind: 'agent', version: 1, previous: null,
      capabilities: { kinds: ['activity', 'document'], verbs: ['read', 'propose', 'send'], spend: allowance },
      ceiling: Sensitivity.MEDIUM, status: 'active',
    };
    const signed = await signRuleset(parentKm, ruleset);
    writeFileSync(`${dir}/ruleset.json`, JSON.stringify(signed, null, 2) + '\n');
    (roster.agents as Record<string, unknown>)[a.name] = { did: id.did, parent: parent.did, allowance };
    process.stdout.write(`agent    ${a.name.padEnd(10)}   ${id.did}\n`);
  }

  writeFileSync(`${agentsRoot}/roster.json`, JSON.stringify(roster, null, 2) + '\n');
  process.stdout.write(`\nroster written -> ${agentsRoot}/roster.json\n`);
}

main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1); });
