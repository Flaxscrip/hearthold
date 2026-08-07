#!/usr/bin/env node
/**
 * `hearthold-agent-mcp` — the agent-as-Sovereign MCP. AUGMENTS Archon's `@didcid/mcp-server`: it REUSES
 * that package's `createArchonRuntime` for the identity binding and adds only the Hearthold custodian verbs
 * (`hearthold_*`). Configure this server alongside the Archon MCP; an agent gets `archon_*` primitives from
 * David's package and `hearthold_*` custodian verbs from here — both bound to the same identity.
 *
 * Bind once via env (HEARTHOLD_* first, ARCHON_* fallback):
 *   HEARTHOLD_WALLET_PATH · HEARTHOLD_GATEKEEPER_URL · HEARTHOLD_REGISTRY · HEARTHOLD_PASSPHRASE
 *   [+ HEARTHOLD_WARDEN_CONTROL_URL / _SIGNET_CONTROL_URL / _EMISSARY_CONTROL_URL for the facade verbs]
 *
 * Per-actor: `--role warden|sovereign|emissary|verifier` (or HEARTHOLD_MCP_ROLE) exposes only that actor's
 * verb set; omit (or `full`) for the original agent-as-principal set. Run one instance per actor, each bound
 * to that actor's wallet + control plane.
 */

import { createArchonRuntime, type ArchonRuntime } from '@didcid/mcp-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadAgentMcpConfig } from './config.js';
import { toolsForRole, type HeartholdToolContext } from './tools.js';
import { buildServer } from './server.js';

/** Resolve the bound identity once (the binding proof) — no mutation. */
async function bindIdentity(runtime: ArchonRuntime): Promise<{ did: string; name: string }> {
  if (!runtime.keymaster) throw new Error('no keymaster in the bound runtime (a passphrase is required)');
  const km = runtime.keymaster;
  const name = await km.getCurrentId();
  if (!name) throw new Error('the bound wallet has no current identity — provision it (Aegis) before binding');
  const doc = await km.resolveDID(name);
  return { did: doc?.didDocument?.id ?? name, name };
}

async function main(): Promise<void> {
  const config = loadAgentMcpConfig();
  const runtime = await createArchonRuntime(config.archon);
  const identity = await bindIdentity(runtime);
  const ctx: HeartholdToolContext = { runtime, control: config.control, identity };
  const tools = toolsForRole(config.role);
  const server = buildServer(ctx, tools);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[hearthold-agent-mcp] role=${config.role} · bound as ${identity.did} (${identity.name}) — ${tools.length} hearthold_* tools over stdio; ` +
      `archon_* via @didcid/mcp-server (sibling)\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[hearthold-agent-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
