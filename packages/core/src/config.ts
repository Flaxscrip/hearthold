import { homedir } from 'node:os';
import { join } from 'node:path';

/** Which Hearthold agent a process is acting as. */
export type AgentRole = 'warden' | 'witness' | 'sovereign' | 'verifier' | 'registry';

export interface HearthholdConfig {
  /**
   * Archon node URL — a Drawbridge front that exposes the gatekeeper API, the capability manifest,
   * and the DIDComm mount (`/didcomm`). The keymaster derives the DIDComm gateway from this, so it
   * must be the Drawbridge URL (e.g. :4222), not the raw Gatekeeper (:4224).
   */
  nodeUrl: string;
  /** Registry used when anchoring operations (e.g. 'hyperswarm' on the local node). */
  registry: string;
  /** Root folder holding per-agent wallets, vault, and index. */
  dataRoot: string;
  /** Witness: the Warden's DID to address over DIDComm. */
  wardenDid?: string;
  /** Witness (projector): the Sovereign's DID to relay sensitive disclosures to (the Signet). */
  sovereignDid?: string;
  /** Warden: local model endpoint for the classifier (Ollama). Stays on-device. */
  ollamaUrl: string;
  /** Warden: local model used to classify sensitivity. */
  classifierModel: string;
  /** Warden: 'ollama' (local model) or 'quarantine' (fail-safe stub, everything SEALED). */
  classifierMode: 'ollama' | 'quarantine';
  /** Signet: PIN that gates the Sovereign's approval of a disclosure (the first proof-of-human). */
  signetPin?: string;
}

const DEFAULT_NODE_URL = 'http://flaxlap.local:4222';
const DEFAULT_REGISTRY = 'hyperswarm';
const DEFAULT_DATA_ROOT = join(homedir(), '.hearthold');
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_CLASSIFIER_MODEL = 'qwen3:8b';

/** Build config from environment with sensible local-node defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HearthholdConfig {
  return {
    nodeUrl: env.HEARTHOLD_NODE_URL ?? DEFAULT_NODE_URL,
    registry: env.HEARTHOLD_REGISTRY ?? DEFAULT_REGISTRY,
    dataRoot: env.HEARTHOLD_DATA_ROOT ?? DEFAULT_DATA_ROOT,
    wardenDid: env.HEARTHOLD_WARDEN_DID,
    sovereignDid: env.HEARTHOLD_SOVEREIGN_DID,
    ollamaUrl: env.HEARTHOLD_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    classifierModel: env.HEARTHOLD_CLASSIFIER_MODEL ?? DEFAULT_CLASSIFIER_MODEL,
    classifierMode: env.HEARTHOLD_CLASSIFIER === 'quarantine' ? 'quarantine' : 'ollama',
    signetPin: env.HEARTHOLD_SIGNET_PIN,
  };
}

/** Per-agent data folder, e.g. ~/.hearthold/warden. */
export function agentDataFolder(config: HearthholdConfig, role: AgentRole): string {
  return join(config.dataRoot, role);
}
