/**
 * Hearthold control-API payload types.
 *
 * The wire contract between the Node agent daemons (`warden control`, `sovereign control`,
 * `witness control`) and the browser GUIs (Warden Console, Signet Approver, Witness). Kept as
 * pure types — no runtime, no Node imports — so both sides import the exact same shapes.
 *
 * Transport: a small JSON HTTP API plus a Server-Sent-Events stream at `GET /api/events`. Every
 * response is `{ ok: true, ... }` or `{ ok: false, error }`.
 */

export const CONTROL_API_VERSION = '0.1.0';

/** Human-readable sensitivity names, indexed by the core `Sensitivity` enum (0..4). */
export type SensitivityName = 'PUBLIC' | 'LOW' | 'MEDIUM' | 'HIGH' | 'SEALED';
export const SENSITIVITY_NAMES: readonly SensitivityName[] = [
  'PUBLIC',
  'LOW',
  'MEDIUM',
  'HIGH',
  'SEALED',
];

/** A Hearthold agent's public identity. */
export interface AgentIdentity {
  role: 'warden' | 'witness' | 'sovereign' | 'verifier' | 'registry';
  name: string;
  did: string;
}

export interface ApiError {
  ok: false;
  error: string;
}
export type ApiResult<T> = ({ ok: true } & T) | ApiError;

/** An event pushed over SSE. `type` names the event; `data` is event-specific. */
export interface ControlEvent<T = unknown> {
  type: string;
  at: string;
  data: T;
}

// ─────────────────────────────── Warden ───────────────────────────────

export interface VaultItem {
  id: string;
  kind: string;
  sensitivity: number;
  sensitivityName: SensitivityName;
  observedAt: string;
}

export interface DelegationRecord {
  subjectDid: string;
  credentialDid: string;
}

export interface WardenStatus {
  identity: AgentIdentity;
  nodeUrl: string;
  dataFolder: string;
  classifier: string;
  artefactCount: number;
  delegationCount: number;
  serving: boolean;
}

export interface WardenSnapshot {
  status: WardenStatus;
  vault: VaultItem[];
  delegations: DelegationRecord[];
}

/** Issue a delegation to a Witness DID. */
export interface DelegateRequest {
  witnessDid: string;
}
export interface DelegateResponse {
  subjectDid: string;
  credentialDid: string;
}

/** Ask the vault a question — private local RAG (nothing leaves the device). */
export interface RecallRequest {
  query: string;
  k?: number;
}
export interface RecallCitationView {
  artefactId: string;
  kind: string;
  observedAt: string;
  score: number;
}
export interface RecallResultView {
  query: string;
  answer: string;
  citations: RecallCitationView[];
  /** Recall answers are model-generated over the vault — fallible, and not a verifiable claim alone. */
  descriptionSource: 'machine-derived';
}
export interface RecallResponse {
  result: RecallResultView;
}

/** Test the classifier on some text (does not store anything). */
export interface ClassifyRequest {
  kind: string;
  text: string;
}
export interface ClassifyResponse {
  sensitivity: number;
  sensitivityName: SensitivityName;
  tags: string[];
  reason: string;
  needsHumanConfirmation: boolean;
}

/** Warden SSE event payloads. */
export interface SubmissionStoredEvent {
  item: VaultItem;
  from: string;
}

// ─────────────────────────────── Signet ───────────────────────────────

/** A disclosure awaiting the Sovereign's proof-of-human approval. */
export interface PendingApproval {
  id: string;
  requester: string;
  /**
   * `proof-request` — present a held credential to a verifier.
   * `evidence-approval` — co-sign the Warden's disclosure of derived, witnessed data.
   */
  kind: 'proof-request' | 'evidence-approval';
  /** Proof-request: the challenge being answered. */
  challengeDid?: string;
  schema?: string;
  sensitivityName?: SensitivityName;
  /** Evidence approval: the Warden-authored claim being disclosed. */
  claim?: string;
  /** Evidence approval: the Warden-authored reason shown to the Sovereign (never the agent's words). */
  reason?: string;
  receivedAt: string;
}

export interface ApprovalHistoryEntry {
  id: string;
  requester: string;
  decision: 'approved' | 'denied';
  method?: string;
  level?: number;
  at: string;
}

export interface SignetStatus {
  identity: AgentIdentity;
  nodeUrl: string;
  serving: boolean;
  pendingCount: number;
}

export interface SignetSnapshot {
  status: SignetStatus;
  pending: PendingApproval[];
  history: ApprovalHistoryEntry[];
}

/** Resolve a pending approval. `pin` is required to approve; ignored on deny. */
export interface ApprovalDecisionRequest {
  id: string;
  approve: boolean;
  pin?: string;
}
export interface ApprovalDecisionResponse {
  id: string;
  decision: 'approved' | 'denied';
}

// ─────────────────────────────── Witness ───────────────────────────────

export interface ReceiptRecord {
  id: string;
  kind: string;
  status: string;
  sensitivityName?: SensitivityName;
  at: string;
}

export interface ProjectionRecord {
  id: string;
  requester: string;
  outcome: 'presented' | 'relayed' | 'declined' | 'error';
  humanProof?: boolean;
  at: string;
}

export interface WitnessStatus {
  identity: AgentIdentity;
  nodeUrl: string;
  wardenDid?: string;
  sovereignDid?: string;
  serving: boolean;
}

/** A summarized provenance group inside a proof (the graph itself is sealed to the Sovereign). */
export interface ProofEvidenceGroup {
  kind: string;
  observedFrom: string;
  observedTo: string;
  count: number;
  witnessedBy: string[];
  merkleRoot: string;
}

/** A "prove a claim" request the Witness sent to the Warden, and how it resolved. */
export interface ProofRecord {
  id: string;
  claim: string;
  kind: string;
  status: 'requesting' | 'granted' | 'denied';
  /** The minted evidence-graph credential, when granted. */
  credentialDid?: string;
  /** The reason, when denied. */
  reason?: string;
  /** Readable summary of what was proven (from the Warden — the credential is sealed). */
  structured?: Record<string, unknown>;
  evidence?: ProofEvidenceGroup[];
  /** Whether the Sovereign co-signed a proof-of-human approval (A2). */
  approved?: boolean;
  /** When this ephemeral proof expires (Archon `validUntil`). */
  validUntil?: string;
  /** Third-party `issued` leaves composed in (external issuer + type) — the strong evidence. */
  issued?: { issuer: string; credentialType: string; schema?: string }[];
  /** Overall trust class: `witnessed`, or `composite` when issued leaves are present. */
  trustClass?: 'witnessed' | 'composite';
  at: string;
}

export interface WitnessSnapshot {
  status: WitnessStatus;
  receipts: ReceiptRecord[];
  projections: ProjectionRecord[];
  proofs: ProofRecord[];
}

/** Submit a captured observation to the Warden. */
export interface SubmitRequest {
  kind: string;
  text: string;
}
export interface SubmitResponse {
  receipt: ReceiptRecord;
}

/** Ask the Warden to prove a claim from witnessed vault data (the A1/A2 evidence flow). */
export interface ProveRequest {
  claim: string;
  kind: string;
  from?: string;
  to?: string;
  /** Optional structured predicate carried into the graph (e.g. {type:'residence',country:'FR'}). */
  structured?: Record<string, unknown>;
  /** How long the minted proof should stay valid, in minutes (default 10). */
  validForMinutes?: number;
}
export interface ProveResponse {
  proof: ProofRecord;
}
