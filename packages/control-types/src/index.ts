/**
 * Hearthold control-API payload types.
 *
 * The wire contract between the Node agent daemons (`warden control`, `sovereign control`,
 * `emissary control`) and the browser GUIs (Warden Console, Signet Approver, Emissary). Kept as
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
  role: 'warden' | 'emissary' | 'sovereign' | 'verifier' | 'registry';
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

/** Which household partition an item belongs to: the shared pool, or a member's private partition. */
export type PartitionScope = 'shared' | 'private';

export interface VaultItem {
  id: string;
  kind: string;
  sensitivity: number;
  sensitivityName: SensitivityName;
  observedAt: string;
  /** Partition origin for the card frame. Populated once session-scoping lands (Phase 3); undefined pre-family. */
  scope?: PartitionScope;
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
  /** Whose view this is — the authenticated session member DID. Undefined when unauthenticated / single-Sovereign. */
  sessionDid?: string;
}

export interface WardenSnapshot {
  status: WardenStatus;
  vault: VaultItem[];
  delegations: DelegationRecord[];
}

/** Issue a delegation to an Emissary DID. */
export interface DelegateRequest {
  emissaryDid: string;
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

/** One Knowledge Base's membership + assurance policy, for the Warden Console KB panel. */
export interface KbView {
  kbId: string;
  readGroup: string;
  writeGroup: string;
  /** DIDs authorized to read (query) / write (contribute). */
  readers: string[];
  writers: string[];
  /** Required assurance per action (governance policy). */
  policy: { read: string; write: string };
  /** True when the policy chain is signed by a governing Sovereign (not the Warden itself). */
  governed: boolean;
}
/** The Warden's Knowledge Bases (one Warden holds many). */
export interface KbListView {
  kbs: KbView[];
}
export interface KbGrantRequest {
  kbId: string;
  did: string;
  scope: 'read' | 'write' | 'both';
}
export interface KbPolicyRequest {
  kbId: string;
  action: 'read' | 'write';
  tier: 'factor1' | 'factor2';
}
export interface RecallCitationView {
  artefactId: string;
  kind: string;
  observedAt: string;
  score: number;
  /** shared-pool vs the member's private partition, for the Divination citation badge (Phase 3). */
  scope?: PartitionScope;
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

// ── Card-face hydration (Sevenfold Table) ──────────────────────────────────────
// Render one card's real face. Every call crosses the Warden's release decision; a refused face is a
// FIRST-CLASS outcome (the Table renders it obsidian), NOT an error. The face is unsealed transiently
// for the response only — never cached, never written to disk outside the vault (G2).

export interface CardFaceRequest {
  artefactId: string;
  /**
   * The authorization tier the caller's session has satisfied (AuthzTier: 1=STANDING, 2=CHALLENGE,
   * 3=HUMAN, 4=MULTIFACTOR). Default STANDING. The ladder applies unreduced — SEALED needs MULTIFACTOR.
   */
  tier?: number;
}

/** Granted → the face; refused → obsidian (still a success envelope). Real failures come back as ApiError. */
export type CardFace =
  | {
      artefactId: string;
      granted: true;
      /** base64-encoded face bytes, held in memory for render only. */
      face: string;
      mimeType: string;
      sensitivity: number;
      sensitivityName: SensitivityName;
    }
  | {
      artefactId: string;
      granted: false;
      /** Why the ladder refused — the Table shows obsidian, never this as an error. */
      reason: string;
      sensitivity: number;
      sensitivityName: SensitivityName;
    };
export interface CardFaceResponse {
  card: CardFace;
}

// ── Triage / born-obsidian confirmation queue (Sevenfold Table) ─────────────────

/** A quarantined artefact awaiting the Sovereign's confirmation (rendered fully obsidian, G1). */
export interface TriageItem {
  artefactId: string;
  kind: string;
  observedAt: string;
  /** The Scribe's proposed sensitivity (accept or override at confirm). */
  proposedSensitivity: number;
  proposedSensitivityName: SensitivityName;
  tags: string[];
  reason: string;
}
export interface TriageQueueResponse {
  queue: TriageItem[];
}
/** Confirm a quarantined artefact at a chosen sensitivity — this human gesture IS the confirmation. */
export interface TriageConfirmRequest {
  artefactId: string;
  sensitivity: number;
}
export interface TriageConfirmResponse {
  item: TriageItem;
}

// ── SevenfoldMark issuance (Warden-issued, explicit claim) ──────────────────────

/** A candidate Mark: its name, what counts toward it (axes-free), and the threshold. */
export interface MarkCandidate {
  markName: string;
  spec: { kind?: string };
  threshold: number;
}
export interface MarkStatus {
  markName: string;
  count: number;
  threshold: number;
  claimable: boolean;
}
export interface MarkClaimableResponse {
  marks: MarkStatus[];
}
export interface MarkClaimRequest {
  candidate: MarkCandidate;
  /** The Sovereign DID the Mark is issued to. Optional — defaults to the Warden's configured Sovereign
   *  (mirrors /api/forge), so the front-end can send just `{ candidate }`. */
  subjectDid?: string;
}
export type MarkClaimResult =
  | { issued: true; markName: string; count: number; threshold: number; credentialDid: string }
  | { issued: false; markName: string; count: number; threshold: number };
export interface MarkClaimResponse {
  result: MarkClaimResult;
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
   * `kb-action` — authorize a factor-2 Knowledge Base action (the Warden's out-of-band step-up).
   * `policy-signature` — sign a Warden policy change (Ruleset governance).
   */
  kind: 'proof-request' | 'evidence-approval' | 'kb-action' | 'policy-signature';
  /** Proof-request: the challenge being answered. */
  challengeDid?: string;
  schema?: string;
  sensitivityName?: SensitivityName;
  /** Evidence approval: the Warden-authored claim being disclosed. */
  claim?: string;
  /** Evidence approval: the Warden-authored reason shown to the Sovereign (never the agent's words). */
  reason?: string;
  /** KB action: the action (`write`/`read`), the KB resource, and a Warden-authored summary. */
  action?: string;
  resource?: string;
  summary?: string;
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

// ─────────────────────────────── Emissary ───────────────────────────────

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

export interface EmissaryStatus {
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

/** A "prove a claim" request the Emissary sent to the Warden, and how it resolved. */
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

export interface EmissarySnapshot {
  status: EmissaryStatus;
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

/**
 * Present a minted Attestation scroll — it BURNS on play (single-use). Home-plane: the Sovereign
 * demonstrates the burn on their own Table; cross-party presentation to an external verifier is the
 * Emissary's job (projecting into the world), so that path stays Emissary-side.
 */
export interface PresentRequest {
  credentialDid: string;
}
export interface PresentResponse {
  verified: boolean;
  /** Why it didn't verify (already spent / expired), when `verified` is false. */
  reason?: string;
}
