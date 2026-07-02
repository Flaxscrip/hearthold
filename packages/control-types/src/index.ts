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

export interface WitnessSnapshot {
  status: WitnessStatus;
  receipts: ReceiptRecord[];
  projections: ProjectionRecord[];
}

/** Submit a captured observation to the Warden. */
export interface SubmitRequest {
  kind: string;
  text: string;
}
export interface SubmitResponse {
  receipt: ReceiptRecord;
}
