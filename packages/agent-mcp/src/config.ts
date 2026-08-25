/**
 * Per-instance binding for the agent-as-Sovereign MCP.
 *
 * We AUGMENT Archon's `@didcid/mcp-server` (David's package) — we do not rewrite it. The keymaster/gatekeeper
 * binding is reused verbatim via its exported `createArchonRuntime(McpServerConfig)`; this module only
 * assembles that config from the environment and adds the Hearthold control-plane URLs the custodian tools
 * need. The whole point of the ask holds: **identity is configuration, never per-call plumbing** — every
 * `hearthold_*` tool then acts implicitly "as me."
 *
 * Env is read HEARTHOLD_*-first (the family-harness convention) with ARCHON_* fallback (the Archon MCP
 * convention), so a bound agent can share either. SECURITY (Aegis): a passphrase per instance is fine for an
 * AGENT key the agent must operate; a HUMAN parent Sovereign's key belongs off-box on their device — never
 * bake one into a server.
 */

import type { McpServerConfig } from '@didcid/mcp-server';

/** Mirrors @didcid/mcp-server's DEFAULT_INLINE_LIMIT (not re-exported from the package root). */
const DEFAULT_INLINE_LIMIT = 16 * 1024;

export interface HeartholdControlConfig {
  /** The agent's own Warden / Signet / Emissary control-plane base URLs (host loopback bridges, client-safe). */
  wardenUrl?: string;
  signetUrl?: string;
  emissaryUrl?: string;
  /** Bearer for a session-guarded control plane (`X-Hearthold-Session`). Usually unset for a bound agent: on a
   *  require-session (multi-member) node the MCP self-logs-in to mint one (see `establishSession` in tools.ts),
   *  so this holds either a pre-provided token (`HEARTHOLD_CONTROL_TOKEN`) or a self-minted session bearer. */
  token?: string;
  /** Epoch ms when a self-minted `token` expires — for proactive re-login before it lapses. */
  tokenExpiresAt?: number;
  /** Registry the self-login `createResponse` must use, passed EXPLICITLY. The ephemeral default is
   *  `hyperswarm`, which hangs on an egress-isolated node; a bound agent uses its own (`local`) registry. */
  registry?: string;
  /** Allow `hearthold_session` to EXPORT a session bearer to the caller (default false). The self-minted
   *  bearer is otherwise process-internal — a security property, not an accident. Set
   *  `HEARTHOLD_MCP_ALLOW_SESSION_EXPORT=true` ONLY on an instance whose consumer must act as this member
   *  through a browser/agent with no HTTP Signet (e.g. the Table rendering a member view). */
  allowSessionExport?: boolean;
}

/**
 * Which actor this MCP instance drives. Each role binds an actor's wallet and exposes only that actor's verb
 * set — the agent-facing realization of the per-actor model. `full` (the default, back-compat) is the original
 * agent-as-principal set (all facets of one agent's stack). See `TOOL_PROFILES` in tools.ts.
 */
export type HeartholdRole = 'warden' | 'sovereign' | 'emissary' | 'verifier' | 'full';

const ROLES: readonly HeartholdRole[] = ['warden', 'sovereign', 'emissary', 'verifier', 'full'];

export interface AgentMcpConfig {
  /** The Archon MCP's own binding config — passed straight into `createArchonRuntime`. */
  archon: McpServerConfig;
  control: HeartholdControlConfig;
  /** The actor role this instance exposes (HEARTHOLD_MCP_ROLE / `--role`; default `full`). */
  role: HeartholdRole;
}

/** Read the role from `--role <r>` or HEARTHOLD_MCP_ROLE; default `full`. Rejects an unknown role. */
function readRole(env: NodeJS.ProcessEnv, argv: string[]): HeartholdRole {
  const i = argv.indexOf('--role');
  const raw = (i >= 0 ? argv[i + 1] : env.HEARTHOLD_MCP_ROLE) ?? 'full';
  const role = raw.toLowerCase() as HeartholdRole;
  if (!ROLES.includes(role)) throw new Error(`unknown --role '${raw}' — one of ${ROLES.join(' | ')}`);
  return role;
}

const pick = (env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined => {
  for (const k of keys) if (env[k]) return env[k];
  return undefined;
};

export function loadAgentMcpConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): AgentMcpConfig {
  const nodeUrl = pick(env, 'HEARTHOLD_GATEKEEPER_URL', 'ARCHON_NODE_URL', 'ARCHON_GATEKEEPER_URL');
  const walletPath = pick(env, 'HEARTHOLD_WALLET_PATH', 'ARCHON_WALLET_PATH');
  const passphrase = pick(env, 'HEARTHOLD_PASSPHRASE', 'ARCHON_PASSPHRASE');
  if (!nodeUrl) throw new Error('a gatekeeper URL is required (HEARTHOLD_GATEKEEPER_URL / ARCHON_NODE_URL) — the isolation-safe endpoint Aegis provisions');
  if (!walletPath) throw new Error('a wallet path is required (HEARTHOLD_WALLET_PATH / ARCHON_WALLET_PATH) — the bound agent identity');
  if (!passphrase) throw new Error('a passphrase is required (HEARTHOLD_PASSPHRASE / ARCHON_PASSPHRASE) to operate the agent key');

  const walletType = (pick(env, 'HEARTHOLD_WALLET_TYPE', 'ARCHON_WALLET_TYPE') ?? 'json') as McpServerConfig['walletType'];
  const defaultRegistry = pick(env, 'HEARTHOLD_REGISTRY', 'ARCHON_DEFAULT_REGISTRY') ?? 'local';
  const readOnly = ['true', '1', 'yes'].includes((pick(env, 'HEARTHOLD_MCP_READ_ONLY', 'ARCHON_MCP_READ_ONLY') ?? '').toLowerCase());

  return {
    archon: { nodeUrl, walletPath, walletType, passphrase, defaultRegistry, readOnly, inlineLimit: DEFAULT_INLINE_LIMIT },
    control: {
      wardenUrl: pick(env, 'HEARTHOLD_WARDEN_CONTROL_URL'),
      signetUrl: pick(env, 'HEARTHOLD_SIGNET_CONTROL_URL'),
      emissaryUrl: pick(env, 'HEARTHOLD_EMISSARY_CONTROL_URL'),
      token: pick(env, 'HEARTHOLD_CONTROL_TOKEN'),
      registry: defaultRegistry,
      allowSessionExport: ['true', '1', 'yes'].includes((pick(env, 'HEARTHOLD_MCP_ALLOW_SESSION_EXPORT') ?? '').toLowerCase()),
    },
    role: readRole(env, argv),
  };
}
