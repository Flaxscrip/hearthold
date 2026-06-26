import { homedir } from 'node:os';
import { join } from 'node:path';

/** Which Hearthold agent a process is acting as. */
export type AgentRole = 'warden' | 'witness';

export interface HearthholdConfig {
  /** Archon Gatekeeper URL used to resolve/register did:cid identities. */
  gatekeeperUrl: string;
  /** Registry used when anchoring operations (e.g. 'hyperswarm' on the local node). */
  registry: string;
  /** Root folder holding per-agent wallets, vault, and index. */
  dataRoot: string;
  /** Warden: address to bind the HTTP service to (default loopback; set to a tailnet IP). */
  bindAddr: string;
  /** Warden: port for the HTTP service. */
  port: number;
  /** Witness: base URL of the Warden over the private (Tailscale) channel. */
  wardenUrl?: string;
}

const DEFAULT_GATEKEEPER_URL = 'http://flaxlap.local:4224';
const DEFAULT_REGISTRY = 'hyperswarm';
const DEFAULT_DATA_ROOT = join(homedir(), '.hearthold');
const DEFAULT_BIND_ADDR = '127.0.0.1';
const DEFAULT_PORT = 8787;

/** Build config from environment with sensible local-node defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HearthholdConfig {
  return {
    gatekeeperUrl: env.HEARTHOLD_GATEKEEPER_URL ?? DEFAULT_GATEKEEPER_URL,
    registry: env.HEARTHOLD_REGISTRY ?? DEFAULT_REGISTRY,
    dataRoot: env.HEARTHOLD_DATA_ROOT ?? DEFAULT_DATA_ROOT,
    bindAddr: env.HEARTHOLD_WARDEN_BIND ?? DEFAULT_BIND_ADDR,
    port: env.HEARTHOLD_WARDEN_PORT ? Number(env.HEARTHOLD_WARDEN_PORT) : DEFAULT_PORT,
    wardenUrl: env.HEARTHOLD_WARDEN_URL,
  };
}

/** Per-agent data folder, e.g. ~/.hearthold/warden. */
export function agentDataFolder(config: HearthholdConfig, role: AgentRole): string {
  return join(config.dataRoot, role);
}
