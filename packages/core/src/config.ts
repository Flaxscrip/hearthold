import { homedir } from 'node:os';
import { join } from 'node:path';

/** Which Hearthold agent a process is acting as. */
export type AgentRole = 'warden' | 'emissary' | 'sovereign' | 'verifier' | 'registry';

export interface HearthholdConfig {
  /**
   * Archon node URL — a Drawbridge front that exposes the gatekeeper API, the capability manifest,
   * and the DIDComm mount (`/didcomm`). The keymaster derives the DIDComm gateway from this, so it
   * must be the Drawbridge URL (e.g. :4222), not the raw Gatekeeper (:4224).
   */
  nodeUrl: string;
  /** Registry used when anchoring operations (e.g. 'hyperswarm' on the local node). */
  registry: string;
  /**
   * Registry for EPHEMERAL DIDs — challenge/response (auth + VP presentation), where the DID is a
   * throwaway. A challenge/response DID is CONTROLLED BY the agent's identity DID (which lives on
   * `registry`), and the gatekeeper correctly refuses to anchor it on a registry whose peers can't resolve
   * that controller — a `hyperswarm` peer has no access to a `local` identity, so it can't validate the
   * response. Keymaster hardcodes the ephemeral default to `hyperswarm` (it does NOT inherit
   * `defaultRegistry`), so an identity on `local` + a response on `hyperswarm` is rejected with an opaque
   * "Upstream gatekeeper error". We default this to `registry` so the ephemeral DID lives on the SAME
   * registry as the identity that controls it (resolvable, consistent). A public deployment whose
   * identities are on hyperswarm can leave it, or set it distinctly, via HEARTHOLD_EPHEMERAL_REGISTRY.
   */
  ephemeralRegistry: string;
  /** Root folder holding per-agent wallets, vault, and index. */
  dataRoot: string;
  /** Emissary: the Warden's DID to address over DIDComm. */
  wardenDid?: string;
  /** Emissary (projector): the Sovereign's DID to relay sensitive disclosures to (the Signet). */
  sovereignDid?: string;
  /** Warden: local model endpoint for the classifier (Ollama). Stays on-device. */
  ollamaUrl: string;
  /** Warden: local model used to classify sensitivity. */
  classifierModel: string;
  /**
   * Warden: local model for RAG answers over recalled passages. Defaults to `classifierModel`; set
   * `HEARTHOLD_ANSWER_MODEL` to use a stronger model for prose answers while keeping classification
   * fast — the two roles have different tradeoffs (classification wants speed, answering wants quality).
   */
  answerModel: string;
  /** Warden: 'ollama' (local model) or 'quarantine' (fail-safe stub, everything SEALED). */
  classifierMode: 'ollama' | 'quarantine';
  /** Warden: local embedding model for the recall index (Ollama). Stays on-device. */
  embeddingModel: string;
  /** Warden: 'ollama' (embed + index on submit) or 'off' (no recall index). */
  indexMode: 'ollama' | 'off';
  /** Signet: PIN that gates the Sovereign's approval of a disclosure (the first proof-of-human). */
  signetPin?: string;
  /**
   * Step-up (Signet approval) timeout in ms, per assurance level. The default 180s can lapse for a live
   * human tap, so it is configurable; clamped to a hard cap so a session can never hang indefinitely.
   */
  stepUpTimeoutMs: { factor1: number; factor2: number };
  /** Control-plane session lifetime in ms (absolute; never slid on use). Default 30 min. */
  sessionTtlMs: number;
}

const DEFAULT_NODE_URL = 'http://flaxlap.local:4222';
const DEFAULT_REGISTRY = 'hyperswarm';
const DEFAULT_DATA_ROOT = join(homedir(), '.hearthold');
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
// Fast by default: a NON-THINKING instruct model, so a fresh install runs well on modest hardware
// (CPU / no GPU passthrough — the common case). Reasoning models (qwen3*, which burn <think> tokens
// before answering) are dramatically slower per call there without being more accurate for a coarse
// sensitivity label. Installs on better hardware opt UP via HEARTHOLD_CLASSIFIER_MODEL (and, for prose
// answers, HEARTHOLD_ANSWER_MODEL).
const DEFAULT_CLASSIFIER_MODEL = 'qwen2.5:3b';
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_STEPUP_TIMEOUT_MS = 180_000;
const STEPUP_TIMEOUT_HARD_CAP_MS = 600_000;
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;

/** Parse a positive-ms env value, clamp to the hard cap, else fall back. */
function resolveTimeout(value: string | undefined, fallback: number): number {
  const n = value !== undefined ? Number(value) : fallback;
  return Number.isFinite(n) && n > 0 ? Math.min(n, STEPUP_TIMEOUT_HARD_CAP_MS) : fallback;
}

/** Build config from environment with sensible local-node defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HearthholdConfig {
  // HEARTHOLD_STEPUP_TIMEOUT_MS sets both levels; per-level overrides are also available.
  const stepUpBase = resolveTimeout(env.HEARTHOLD_STEPUP_TIMEOUT_MS, DEFAULT_STEPUP_TIMEOUT_MS);
  const classifierModel = env.HEARTHOLD_CLASSIFIER_MODEL ?? DEFAULT_CLASSIFIER_MODEL;
  return {
    nodeUrl: env.HEARTHOLD_NODE_URL ?? DEFAULT_NODE_URL,
    registry: env.HEARTHOLD_REGISTRY ?? DEFAULT_REGISTRY,
    ephemeralRegistry: env.HEARTHOLD_EPHEMERAL_REGISTRY ?? env.HEARTHOLD_REGISTRY ?? DEFAULT_REGISTRY,
    dataRoot: env.HEARTHOLD_DATA_ROOT ?? DEFAULT_DATA_ROOT,
    wardenDid: env.HEARTHOLD_WARDEN_DID,
    sovereignDid: env.HEARTHOLD_SOVEREIGN_DID,
    ollamaUrl: env.HEARTHOLD_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    classifierModel,
    // The RAG answerer follows the classifier unless separately overridden (back-compat: one var still
    // moved both). Split so a strong-hardware install can raise answer quality without slowing classify.
    answerModel: env.HEARTHOLD_ANSWER_MODEL ?? classifierModel,
    classifierMode: env.HEARTHOLD_CLASSIFIER === 'quarantine' ? 'quarantine' : 'ollama',
    embeddingModel: env.HEARTHOLD_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    indexMode: env.HEARTHOLD_INDEX === 'off' ? 'off' : 'ollama',
    signetPin: env.HEARTHOLD_SIGNET_PIN,
    stepUpTimeoutMs: {
      factor1: resolveTimeout(env.HEARTHOLD_STEPUP_TIMEOUT_FACTOR1_MS, stepUpBase),
      factor2: resolveTimeout(env.HEARTHOLD_STEPUP_TIMEOUT_FACTOR2_MS, stepUpBase),
    },
    sessionTtlMs: (() => {
      const n = Number(env.HEARTHOLD_SESSION_TTL_MS);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_TTL_MS;
    })(),
  };
}

/** Per-agent data folder, e.g. ~/.hearthold/warden. */
export function agentDataFolder(config: HearthholdConfig, role: AgentRole): string {
  return join(config.dataRoot, role);
}
