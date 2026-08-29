import { homedir } from 'node:os';
import { join } from 'node:path';

import { Sensitivity } from './security.js';

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
   * The registry newly-created CONTENT is born on — documents, images/Keymaster image assets, vault
   * credentials (delegations, evidence scrolls, marks), schemas — INDEPENDENT of the identity `registry`.
   * Default **`local`**: privacy/isolation by construction (new content is the Sovereign's private data on
   * their node; it doesn't queue for gossip unless deliberately PROMOTED), and it avoids the never-confirms
   * stall of creating on `hyperswarm` behind a slow/absent mediator. So a FEDERATED Sovereign (identity on
   * `hyperswarm`, to cross spheres) still creates content `local` — cross-sphere sharing is an explicit
   * promote (e.g. card-pass ships the ops), not the birth state. Env: `HEARTHOLD_CONTENT_REGISTRY`.
   */
  contentRegistry: string;
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
  /**
   * Registry for ACCESS-CONTROL groups (a KB's read/write groups). Separate from `registry` so a KB can have
   * a PUBLICLY-resolvable identity (so members on other nodes can verify its login challenges) while its
   * MEMBERSHIP stays PRIVATE — group membership updates are DIDs that gossip on a public registry even though
   * the sealed content never does, so born-local groups keep *who is a member* off the federation. A
   * hyperswarm-identity Warden manages `local` groups fine (the gatekeeper only forbids a local controller
   * creating a NON-local asset, not the reverse). Defaults to `registry` (groups follow the identity — the
   * historical behaviour); set `HEARTHOLD_GROUPS_REGISTRY=local` with a `hyperswarm` identity for a
   * public-Warden / private-membership KB. Env: `HEARTHOLD_GROUPS_REGISTRY`.
   */
  groupsRegistry: string;
  /** Root folder holding per-agent wallets, vault, and index. */
  dataRoot: string;
  /** Emissary: the Warden's DID to address over DIDComm. */
  wardenDid?: string;
  /** Emissary (projector): the Sovereign's DID to relay sensitive disclosures to (the Signet). */
  sovereignDid?: string;
  /**
   * Agent-family: the PARENT/governor Sovereign's DID (`did:cid:…ij3ufa` in the node family). Set on an AGENT
   * Warden plane so that a disclosure above the agent's standing authority — a readable card pass, a sensitive
   * forge — escalates the co-sign to the parent's Signet, not the agent's own. Absent ⇒ a classic
   * single-Sovereign plane: co-signs route to the acting member as before (back-compat). See docs/agent-family.md.
   */
  parentDid?: string;
  /**
   * Agent-family CONTROL surface: the Archon asset DID holding this AI-agent Sovereign's OWN parent-signed
   * Ruleset chain (`SignedRuleset[]`), whose head `capabilities.control` is the control-allowance the
   * `AgentGate` self-approves within. The sovereign daemon has no Warden-side RulesetStore, so the pointer
   * to its own governing chain is supplied here (env `HEARTHOLD_CONTROL_ALLOWANCE_ASSET`) — resolved and
   * verified under governor-pinning against `parentDid`. Absent ⇒ no allowance ⇒ deny-by-default: every
   * above-standing control act escalates to the parent (a self-signed or wrong-signer chain fails the pin
   * and is treated as absent). See docs/agentgate-allowance.md.
   */
  controlAllowanceAsset?: string;
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
  /**
   * Warden: local VISION model that captions an `image` submission (description + tags) BEFORE the text
   * classifier assigns sensitivity — so images inherit every gate (classify → ingestion quarantine → triage
   * → recall) with no parallel pipeline. Same `ollamaUrl` + `/api/chat` shape as the classifier, just an
   * `images:[b64]` attachment. Default a SMALL model (`moondream`) for modest hardware; opt up via
   * `HEARTHOLD_VISION_MODEL` (`llava`, `llama3.2-vision`, …). Absent/errored ⇒ the image classifies SEALED
   * (fail-closed) so a missing model quarantines rather than leaks. On-device; no egress.
   */
  visionModel: string;
  /** Warden: 'ollama' (local model) or 'quarantine' (fail-safe stub, everything SEALED). */
  classifierMode: 'ollama' | 'quarantine';
  /** Warden: local embedding model for the recall index (Ollama). Stays on-device. */
  embeddingModel: string;
  /** Warden: 'ollama' (embed + index on submit) or 'off' (no recall index). */
  indexMode: 'ollama' | 'off';
  /** Signet: PIN that gates the Sovereign's approval of a disclosure (the first proof-of-human). */
  signetPin?: string;
  /**
   * How `sovereign control`'s gate authorizes: `human` (default) = HttpGate — a person approves each act with the
   * PIN (proof-of-human). `agent` = AgentGate — an AI-agent Sovereign SELF-APPROVES within its parent-signed
   * allowance (no PIN, receipts), keeping standing autonomy while exposing the HTTP surface; above-allowance acts
   * escalate to the parent's Signet via the Warden's ladder. env `HEARTHOLD_GATE_MODE`.
   */
  gateMode: 'human' | 'agent';
  /**
   * Step-up (Signet approval) timeout in ms, per assurance level. The default 180s can lapse for a live
   * human tap, so it is configurable; clamped to a hard cap so a session can never hang indefinitely.
   */
  stepUpTimeoutMs: { factor1: number; factor2: number };
  /**
   * How long `POST /api/card/pass` waits for the recipient's accept/decline ack in ms. The pass blocks on a
   * cross-node DIDComm round-trip, and over a Tor substrate (double-onion + retries) a slow-but-successful
   * ack can exceed the 60s default and be abandoned. Raise it for such deployments (Aegis sets ~180s). Env:
   * `HEARTHOLD_CARD_PASS_TIMEOUT_MS`, clamped to the same 600s hard cap as the step-up.
   */
  cardPassTimeoutMs: number;
  /** Control-plane session lifetime in ms (absolute; never slid on use). Default 30 min. */
  sessionTtlMs: number;
  /**
   * Ingestion gate: a submission whose sensitivity is `<= confirmAtOrBelow` is QUARANTINED (born-obsidian,
   * awaiting the Sovereign's triage-confirm) rather than admitted to the vault corpus. Default **SEALED** so
   * `sensitivity <= SEALED` is always true → **everything quarantines** (safe: an Emissary may PROPOSE, only
   * the Sovereign ADMITS). Lower it (MEDIUM/LOW) to auto-admit the tiers above the bound. Env:
   * `HEARTHOLD_CONFIRM_AT_OR_BELOW` (a label PUBLIC|LOW|MEDIUM|HIGH|SEALED or a number 0–4). A per-Emissary
   * `autofile` trust-registry grant bypasses this floor for a trusted device.
   */
  confirmAtOrBelow: Sensitivity;
  /**
   * WARDEN POLICY human gate for evidence disclosure (invocation): a disclosure at or above this sensitivity
   * REQUIRES the owner's fresh signed consent (a discharge), regardless of whether the capability's issuer
   * attached a `requiresDischarge` caveat. Default **MEDIUM** (PUBLIC/LOW clear without a human; MEDIUM+ needs
   * one) — so a `ceiling: SEALED` capability cannot disclose SEALED with no human in the loop. Env:
   * `HEARTHOLD_REQUIRES_HUMAN_AT` (a label PUBLIC|LOW|MEDIUM|HIGH|SEALED or a number 0–4).
   */
  requiresHumanAt: Sensitivity;
  /**
   * Revocation-by-default (audit-3 §4): when true (default), the Warden refuses a capability that carries no
   * `credentialStatus` pointer — a capability that can never be revoked is denied rather than trusted forever.
   * `issueScopeCapability` allocates a status by default so honest capabilities satisfy this. Env:
   * `HEARTHOLD_REQUIRE_REVOCABLE` (`0`/`false` to allow non-revocable capabilities).
   */
  requireRevocableCapabilities: boolean;
  /**
   * The canonical HearthholdAuthorization schema DID the ISSUER (Sovereign) mints scope capabilities against.
   * A `did:cid` schema is registered ONCE — its registrant is the Controller — and is resolvable + reusable by
   * any issuer within the same registry sphere (local / hyperswarm). So the model is *one canonical schema,
   * many issuers*: the Warden registers it, and the Sovereign resolves and reuses that one DID for issuance (a
   * verifier's challenge matches on the schema DID). This config distributes that canonical DID to the issuer
   * (env `HEARTHOLD_AUTHORIZATION_SCHEMA_DID` = the Warden's registered schema); unset ⇒ the issuer registers
   * its own, which is only valid when issuer and verifier share a wallet (single-wallet dev).
   */
  authorizationSchemaDid?: string;
  /**
   * CGPR autonomy threshold (Phase 2): an external Consent-Gated Preference request whose disclosure is at or
   * below this sensitivity clears **autonomously** (no per-request Signet consent); above it, the gateway steps
   * up to the Sovereign's Signet. Default **LOW**, deliberately STRICTER than the internal `requiresHumanAt` —
   * an external AI requester warrants more caution than the Sovereign's own Emissary. Env:
   * `HEARTHOLD_CGPR_AUTONOMOUS_AT` (a label PUBLIC|LOW|MEDIUM|HIGH|SEALED or a number 0–4).
   */
  cgprAutonomousAtOrBelow: Sensitivity;
  /**
   * The interface the control-plane HTTP daemons (Warden `:4310`, Signet `:4311`) bind to. Defaults to
   * `127.0.0.1` (loopback only — the safe default; the control API is unauthenticated-at-transport). An
   * isolated-node deployment that fronts the daemon with its own bridge can set `HEARTHOLD_CONTROL_HOST=0.0.0.0`
   * to bind the container interface directly. NEVER expose the Signet beyond loopback/your own bridge.
   */
  controlHost: string;
  /**
   * Extra browser origins allowed to call the control plane, beyond loopback (which is always allowed on any
   * port). Add a deployed Table's origin here (e.g. `https://table.example`). Env: comma-separated
   * `HEARTHOLD_CONTROL_ALLOW_ORIGIN`. Never a wildcard — the default (loopback-only) is the safe posture.
   */
  controlAllowOrigins: string[];
  /**
   * Require a proven session for every scoped control read — retire the anonymous Sovereign fallback.
   * `true`/`false` force it; `undefined` (env unset) means DERIVE it: on once the node is multi-member
   * (a household exists, or a KB space has a member other than the Sovereign), off for a bare
   * single-Sovereign node. Env: `HEARTHOLD_REQUIRE_SESSION=true|false`.
   */
  requireSession?: boolean;
  /**
   * The ephemeral, PEERLESS gatekeeper a cross-node inbound credential is verified inside (the DMZ) — never
   * the node's own gatekeeper (B6). A foreign card's ops are imported here, its chain verified, only the
   * verified closure kept, and the DMZ torn down. Must resolve to a mediator-less gatekeeper (registry
   * `local`, or Aegis's node-B raw gatekeeper) so nothing propagates. Env: `HEARTHOLD_DMZ_URL`. Unset ⇒ no
   * DMZ ⇒ cross-node cards stay `verified:false` (fail closed — we never import foreign ops to verify them).
   */
  dmzNodeUrl?: string;
  /** Admin key for the DMZ gatekeeper, if it requires one for import. Env: `HEARTHOLD_DMZ_API_KEY`. */
  dmzApiKey?: string;
  /**
   * Skip the DMZ target's peerless interrogation (`listRegistries`) — the explicit, loud escape hatch for a
   * stand-in target (e.g. flaxlap's raw gatekeeper in tests). NEVER set in production against a peered node.
   * Env: `HEARTHOLD_DMZ_ASSUME_PEERLESS=true`.
   */
  dmzAssumePeerless?: boolean;
}

const DEFAULT_NODE_URL = 'http://flaxlap.local:4222';
// Secure by default: `local` is the DB-only registry — it anchors DIDs on the node and NEVER queues them to
// a gossip/chain mediator, so private data cannot propagate regardless of the node's hyperswarm topic. The
// keymaster's `defaultRegistry` is set to this, so it flows through every op (issuance included) — the
// sandbox runs the full credential/prove flow offline on `local`. Publishing/sharing cross-node or on a
// public network is a DELIBERATE opt-in: set `HEARTHOLD_REGISTRY` to `hyperswarm` (gossips on the node's
// topic — private only if that topic is private) or a chain registry. Archon's reference node still defaults
// to public `hyperswarm`; Hearthold does not inherit that — born local, promoted never (unless you ask).
const DEFAULT_REGISTRY = 'local';
const DEFAULT_DATA_ROOT = join(homedir(), '.hearthold');
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
// Fast by default: a NON-THINKING instruct model, so a fresh install runs well on modest hardware
// (CPU / no GPU passthrough — the common case). Reasoning models (qwen3*, which burn <think> tokens
// before answering) are dramatically slower per call there without being more accurate for a coarse
// sensitivity label. Installs on better hardware opt UP via HEARTHOLD_CLASSIFIER_MODEL (and, for prose
// answers, HEARTHOLD_ANSWER_MODEL).
const DEFAULT_CLASSIFIER_MODEL = 'qwen2.5:3b';
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_VISION_MODEL = 'moondream'; // ~1.7 GB — hackathon-class hardware copes; opt up via env
const DEFAULT_STEPUP_TIMEOUT_MS = 180_000;
const STEPUP_TIMEOUT_HARD_CAP_MS = 600_000;
const DEFAULT_CARD_PASS_TIMEOUT_MS = 60_000; // matches the transport default; raise via env for a Tor substrate
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;

/** Parse a positive-ms env value, clamp to the hard cap, else fall back. */
function resolveTimeout(value: string | undefined, fallback: number): number {
  const n = value !== undefined ? Number(value) : fallback;
  return Number.isFinite(n) && n > 0 ? Math.min(n, STEPUP_TIMEOUT_HARD_CAP_MS) : fallback;
}

const SENSITIVITY_BY_LABEL: Record<string, Sensitivity> = {
  PUBLIC: Sensitivity.PUBLIC,
  LOW: Sensitivity.LOW,
  MEDIUM: Sensitivity.MEDIUM,
  HIGH: Sensitivity.HIGH,
  SEALED: Sensitivity.SEALED,
};

/** Parse a sensitivity from a label (PUBLIC…SEALED) or number 0–4; fall back (safe) on anything else. */
function parseSensitivity(value: string | undefined, fallback: Sensitivity): Sensitivity {
  if (value === undefined) return fallback;
  const byLabel = SENSITIVITY_BY_LABEL[value.trim().toUpperCase()];
  if (byLabel !== undefined) return byLabel;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? (n as Sensitivity) : fallback;
}

/** Build config from environment with sensible local-node defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HearthholdConfig {
  // HEARTHOLD_STEPUP_TIMEOUT_MS sets both levels; per-level overrides are also available.
  const stepUpBase = resolveTimeout(env.HEARTHOLD_STEPUP_TIMEOUT_MS, DEFAULT_STEPUP_TIMEOUT_MS);
  const classifierModel = env.HEARTHOLD_CLASSIFIER_MODEL ?? DEFAULT_CLASSIFIER_MODEL;
  return {
    nodeUrl: env.HEARTHOLD_NODE_URL ?? DEFAULT_NODE_URL,
    registry: env.HEARTHOLD_REGISTRY ?? DEFAULT_REGISTRY,
    // Content is born `local` by default, REGARDLESS of the identity registry (privacy by construction +
    // avoids the hyperswarm never-confirms stall). Federation is a deliberate promote, not the birth state.
    contentRegistry: env.HEARTHOLD_CONTENT_REGISTRY ?? DEFAULT_REGISTRY,
    ephemeralRegistry: env.HEARTHOLD_EPHEMERAL_REGISTRY ?? env.HEARTHOLD_REGISTRY ?? DEFAULT_REGISTRY,
    groupsRegistry: env.HEARTHOLD_GROUPS_REGISTRY ?? env.HEARTHOLD_REGISTRY ?? DEFAULT_REGISTRY,
    dataRoot: env.HEARTHOLD_DATA_ROOT ?? DEFAULT_DATA_ROOT,
    wardenDid: env.HEARTHOLD_WARDEN_DID,
    sovereignDid: env.HEARTHOLD_SOVEREIGN_DID,
    parentDid: env.HEARTHOLD_PARENT_DID,
    controlAllowanceAsset: env.HEARTHOLD_CONTROL_ALLOWANCE_ASSET,
    ollamaUrl: env.HEARTHOLD_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    visionModel: env.HEARTHOLD_VISION_MODEL ?? DEFAULT_VISION_MODEL,
    classifierModel,
    // The RAG answerer follows the classifier unless separately overridden (back-compat: one var still
    // moved both). Split so a strong-hardware install can raise answer quality without slowing classify.
    answerModel: env.HEARTHOLD_ANSWER_MODEL ?? classifierModel,
    classifierMode: env.HEARTHOLD_CLASSIFIER === 'quarantine' ? 'quarantine' : 'ollama',
    embeddingModel: env.HEARTHOLD_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    indexMode: env.HEARTHOLD_INDEX === 'off' ? 'off' : 'ollama',
    signetPin: env.HEARTHOLD_SIGNET_PIN,
    gateMode: env.HEARTHOLD_GATE_MODE === 'agent' ? 'agent' : 'human',
    stepUpTimeoutMs: {
      factor1: resolveTimeout(env.HEARTHOLD_STEPUP_TIMEOUT_FACTOR1_MS, stepUpBase),
      factor2: resolveTimeout(env.HEARTHOLD_STEPUP_TIMEOUT_FACTOR2_MS, stepUpBase),
    },
    cardPassTimeoutMs: resolveTimeout(env.HEARTHOLD_CARD_PASS_TIMEOUT_MS, DEFAULT_CARD_PASS_TIMEOUT_MS),
    sessionTtlMs: (() => {
      const n = Number(env.HEARTHOLD_SESSION_TTL_MS);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_TTL_MS;
    })(),
    confirmAtOrBelow: parseSensitivity(env.HEARTHOLD_CONFIRM_AT_OR_BELOW, Sensitivity.SEALED),
    requiresHumanAt: parseSensitivity(env.HEARTHOLD_REQUIRES_HUMAN_AT, Sensitivity.MEDIUM),
    requireRevocableCapabilities: env.HEARTHOLD_REQUIRE_REVOCABLE !== 'false' && env.HEARTHOLD_REQUIRE_REVOCABLE !== '0',
    ...(env.HEARTHOLD_AUTHORIZATION_SCHEMA_DID ? { authorizationSchemaDid: env.HEARTHOLD_AUTHORIZATION_SCHEMA_DID } : {}),
    cgprAutonomousAtOrBelow: parseSensitivity(env.HEARTHOLD_CGPR_AUTONOMOUS_AT, Sensitivity.LOW),
    controlHost: env.HEARTHOLD_CONTROL_HOST ?? '127.0.0.1',
    controlAllowOrigins: (env.HEARTHOLD_CONTROL_ALLOW_ORIGIN ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    requireSession:
      env.HEARTHOLD_REQUIRE_SESSION === 'true'
        ? true
        : env.HEARTHOLD_REQUIRE_SESSION === 'false'
          ? false
          : undefined,
    dmzNodeUrl: env.HEARTHOLD_DMZ_URL,
    dmzApiKey: env.HEARTHOLD_DMZ_API_KEY,
    dmzAssumePeerless: env.HEARTHOLD_DMZ_ASSUME_PEERLESS === 'true' ? true : undefined,
  };
}

/** Per-agent data folder, e.g. ~/.hearthold/warden. */
export function agentDataFolder(config: HearthholdConfig, role: AgentRole): string {
  return join(config.dataRoot, role);
}

/**
 * Ollama chat-body fields that DISABLE the hidden `<think>` reasoning pass — but ONLY for models that
 * actually reason. The `/no_think` PROMPT idiom is ineffective on current Ollama (0.32.x): the string is
 * passed through and a reasoning model reasons anyway (measured 15.7x waste on qwen3:8b — 11.6s/361tok vs
 * 0.74s/29tok — the hidden reasoning nobody ever sees, on every query). The top-level `think` request field
 * superseded it. We send `think:false` ONLY when the model is a known reasoning family: on a non-thinking
 * model (the qwen2.5 / moondream defaults) the field is unnecessary and some Ollama builds 400 on it — and
 * both the classifier and vision paths fail CLOSED to SEALED, so a blanket `think:false` would risk silently
 * quarantining everything. Model-aware keeps the defaults untouched while killing the qwen3 latency. The
 * list is intentionally conservative — extend it as we adopt other reasoning models.
 */
export function noThink(model: string): { think: false } | Record<string, never> {
  return /qwen3|deepseek-r1|magistral|\bthinking\b/i.test(model) ? { think: false } : {};
}
