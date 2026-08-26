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

/**
 * The request header carrying the session bearer token minted by `POST /api/login/complete`. Clients send
 * it on every scoped request; the server derives the session DID from it (never trust a client-asserted DID).
 * Use the constant instead of string-literalling the header.
 */
export const HEARTHOLD_SESSION_HEADER = 'X-Hearthold-Session';

/** Human-readable sensitivity names, indexed by the core `Sensitivity` enum (0..4). */
export type SensitivityName = 'PUBLIC' | 'LOW' | 'MEDIUM' | 'HIGH' | 'SEALED';
export const SENSITIVITY_NAMES: readonly SensitivityName[] = [
  'PUBLIC',
  'LOW',
  'MEDIUM',
  'HIGH',
  'SEALED',
];

/**
 * Canonical vocabulary for the words that were historically overloaded — so every agent and GUI cites ONE
 * source instead of tracking prose. Mirrors `docs/terminology.md` (the repo's source of truth); keep the two
 * in sync. Import `HEARTHOLD_TERMINOLOGY.Sphere` etc. rather than re-explaining a term in local copy.
 */
export type HeartholdTerm = 'Sphere' | 'community' | 'space' | 'KB' | 'KbSpace' | 'partition';
export const HEARTHOLD_TERMINOLOGY: Readonly<Record<HeartholdTerm, string>> = {
  Sphere:
    'A named publication target: the (Gatekeeper URL, registry) operations publish onto (core/sphere.ts). The anchoring layer — never a KB, partition, space, or community. A shared KB rides on a Sphere but is not one.',
  community:
    'A group of members under a shared issuer/registry (a C-DID issuing VMC membership; the PVM "G" factor). Formerly called a "sphere" — that usage is retired.',
  space:
    'The app-layer aggregator bundle — a partition/space + Artefact.owner/scope + a kind-scoped delegation. Formerly overloaded as "sphere".',
  KB: 'A shared, collaborative Knowledge Base identified by a kbId (the collaborative pool).',
  KbSpace: 'A KB with per-member private partitions turned on (memberPartitions).',
  partition: 'A shared vs private DB within a KB. Not a personal vault — that is a "vault".',
};

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
  /** Vault metadata — omitted pre-login on a require-session node (liveness + identity are enough to log in). */
  artefactCount?: number;
  delegationCount?: number;
  serving: boolean;
  /** Whose view this is — the authenticated session member DID. Undefined when unauthenticated / single-Sovereign.
   *  PRODUCER RULE: populate this ONLY from the PROVEN session (`sessions.resolve(token)`), NEVER from the
   *  "effective viewer" we filter by — the latter falls back to the configured Sovereign on a single-Sovereign
   *  node, and reporting that here would label a Sovereign as a session member (the viewer-vs-proven-identity
   *  conflation behind the over-disclosure class). This DTO answers "who did we PROVE is calling", not "who do
   *  we filter by"; the two are equal only when a session exists. */
  sessionDid?: string;
  /**
   * The canonical HearthholdAuthorization schema DID this Warden's invocation challenge requests. Wire it into
   * the Sovereign's `HEARTHOLD_AUTHORIZATION_SCHEMA_DID` so its granted scope VCs match (schema DIDs are not
   * content-addressed across wallets). Its absence is what causes "invocation refused: challenge not satisfied".
   */
  authorizationSchemaDid?: string;
  /** The canonical delegation schema DID (issued + challenged by the Warden itself). */
  delegationSchemaDid?: string;
}

export interface WardenSnapshot {
  status: WardenStatus;
  vault: VaultItem[];
  delegations: DelegationRecord[];
}

/** Issue a delegation to an Emissary DID. */
/** A witness kind a delegation may grant / a submission may carry. Mirrors core's `WitnessKind` (dep-free). */
export type WitnessKindName = 'event' | 'location' | 'activity' | 'browsing' | 'document' | 'book' | 'link' | 'image';

export interface DelegateRequest {
  emissaryDid: string;
  /**
   * Scope this Emissary to only these kinds (compartmentalized per-path Emissaries — e.g. `['image']` for a
   * dedicated image Emissary). Omitted ⇒ the default text set (no `image` — that needs an explicit grant).
   */
  kinds?: WitnessKindName[];
}

/** `POST :4312/api/submit` (Table → Emissary control plane) — a binary attachment beside optional text. */
export interface WitnessAttachment {
  /** e.g. `image/jpeg`, `image/png`. */
  mediaType: string;
  /** Base64 of the bytes. The Emissary turns this into the sealed payload / a native image asset. */
  bytesB64: string;
}
export interface DelegateResponse {
  subjectDid: string;
  credentialDid: string;
}

// ── Multi-hop chain capabilities (Phase 5B) — the Emissary + Sovereign daemon routes ────────────────────

/** `POST :4312/api/delegate-capability` — hand a narrower slice of a HELD capability onward to another agent. */
export interface DelegateCapabilityRequest {
  /** The DID of the agent's Emissary to delegate to. */
  holderDid: string;
  /** Child ceiling (0 PUBLIC … 4 SEALED); must be ≤ the held capability's. */
  ceiling?: number;
  /** Witness kinds the child may prove; must be ⊆ the held capability's. */
  kinds?: WitnessKindName[];
  /** Invocation target; within the held capability's (default: the same). */
  target?: string;
  /** Which held capability to delegate from (default: the most-recently held). */
  leafVcDid?: string;
}
export interface DelegateCapabilityResponse {
  childVcDid: string;
  holder: string;
  statusListIndex: number;
}

/** `POST :4312/api/chain-invoke` — present a HELD chain to prove a fact (the multi-hop analog of invoke). */
export interface ChainInvokeRequest {
  claim: string;
  kind: string;
  /** Which held chain to present (default: the latest). */
  leafVcDid?: string;
  reveal?: number[];
}

/** `POST :4312/api/revoke-hop` — a delegator's kill-switch over a hop it issued. */
export interface RevokeHopRequest {
  childVcDid: string;
}
export interface RevokeHopResponse {
  revoked: boolean;
  childVcDid: string;
}

/** `GET :4312/api/held` — the chain capabilities this Emissary holds + the hops it has issued onward. */
export interface HeldChainView {
  leafVcDid: string;
  counter: number;
  target: string;
  ceiling: number;
}
export interface IssuedHopView {
  childVcDid: string;
  holder: string;
  statusListCredential: string;
  statusListIndex: number;
  issuedAt: string;
}
export interface HeldResponse {
  held: HeldChainView[];
  issued: IssuedHopView[];
}

/** `POST :4311/api/mint-root` (Signet) — seed an agent's Emissary with a ROOT chain-capability. */
export interface MintRootRequest {
  emissaryDid: string;
  /** Max sensitivity — PUBLIC|LOW|MEDIUM|HIGH|SEALED (default MEDIUM). */
  ceiling?: string;
  kinds?: WitnessKindName[];
  target?: string;
}
export type MintRootResponse =
  | { minted: true; rootVcDid: string; holder: string }
  | { minted: false; declined: true };

/** Ask the vault a question — private local RAG (nothing leaves the device). */
export interface RecallRequest {
  query: string;
  k?: number;
  /**
   * The sensitivity band the answer may draw on (0=PUBLIC … 4=SEALED). Default LOW. Requesting MEDIUM+ runs a
   * real step-up to the member's own Signet server-side (recall is a disclosure like a card face); the ceiling
   * granted is exactly what the achieved tier clears — a bare session never summarizes SEALED content for free.
   */
  maxSensitivity?: number;
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

// ── Login / session (member challenge-response → bearer token) ──────────────────
// The session routes on `warden control`. A member proves a DID via challenge/response and receives a
// bearer token sent thereafter as `HEARTHOLD_SESSION_HEADER`. The server derives the session DID from the
// token server-side; no route trusts a client-asserted DID.

/** `POST /api/login/start` — mint a challenge for the member to sign. */
export interface LoginStartRequest {
  /** Optional callback DID for the challenge. */
  callback?: string;
}
export interface LoginStartResponse {
  /** The challenge DID the member's wallet signs a response to. */
  challenge: string;
}

/** `POST /api/login/complete` — submit the signed response; on verify, mint a session. */
export interface LoginCompleteRequest {
  /** The response DID (member-signed) proving control of their DID. */
  response: string;
}
export interface LoginCompleteResponse {
  /** The session bearer token — send as `HEARTHOLD_SESSION_HEADER` on subsequent requests. */
  token: string;
  /** ISO timestamp the session expires (absolute; not slid on use). */
  expiresAt: string;
  /** The proven member DID this session acts as. */
  did: string;
}

/** `GET /api/whoami` — the session's identity (requires `HEARTHOLD_SESSION_HEADER`). */
export interface WhoamiResponse {
  did: string;
  expiresAt: string | null;
}

/**
 * `POST /api/session/unlock` — rewrap the member's private partitions for this session (read-guest). Prompts
 * the member's OWN Signet for proof-of-human; the Warden holds the rewrapped keys only for the session TTL.
 */
export interface SessionUnlockResponse {
  /** Partition ids unlocked, or a count — the read-guest rewrap result. */
  unlocked: string[] | number;
}

/** `POST /api/logout` — revoke the session and zeroize any read-guest keys immediately. */
export interface LogoutResponse {
  ok: true;
  /** Whether a live session was actually revoked (false if the token was already invalid/absent). */
  revoked: boolean;
}

/**
 * `POST /api/login/sign` — on the SIGNET daemon (`:4311`), not the Warden. The Signet-brokered middle hop
 * of control login: the browser relays the Warden's challenge to the member's own Signet, which — after a
 * human PIN gate and ONLY if the challenge's purpose is `hearthold-control` — signs it with keys that never
 * leave the Signet, and returns the response DID for the browser to relay to `POST /api/login/complete`.
 * The purpose scope is the security hinge: a compromised browser can request a login (the human sees + PINs
 * it) but cannot drive the Signet to sign an arbitrary challenge for some other purpose.
 */
export interface LoginSignRequest {
  /** The challenge DID minted by `POST /api/login/start` (Warden). */
  challenge: string;
}
/** The member-signed response DID to relay to `login/complete`, or a decline (refused purpose / human denied). */
export type LoginSignResponse = { response: string } | { declined: true };

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

// ── Card pass (deliver a credential to another node) ────────────────────────────
// `POST /api/card/pass` wraps core `deliverCredential`. Session-scoped: the deliverer is the authenticated
// session member (never a client-asserted issuer); `toDid` is the recipient Sovereign. Passing a card
// crosses a PUBLICATION boundary (it discloses a credential to another party), so it triggers a Sovereign
// co-sign — the session member's own Signet step-up — per docs/CO-SIGN-POLICY.md. "Sent ≠ gone":
// `encryptJSON` is encrypt-for-sender, so the ack confirms delivery; it removes nothing from the sender.
export interface CardPassRequest {
  /** The recipient Sovereign DID. */
  toDid: string;
  /** The credential (VC asset) to pass. */
  credentialDid: string;
  /** The schema DID the VC conforms to; derived if omitted. */
  schemaDid?: string;
  /**
   * Pass a READABLE card (default false). When true the sender seals a rendering of the claims to `toDid`, so
   * the recipient's card arrives `contentReadable:true` with the claims — a bigger disclosure than provenance
   * (it crosses `decideRelease`), which the pass co-sign covers (the human sees "readable" in the summary).
   * Default (false) hands over a provenance-only reference: chain-verified issuer/type, no claims.
   */
  readable?: boolean;
}

/** The recipient's accept/decline ack (mirrors core `CredentialDeliveryAckMessage`; control-types stays dep-free). */
export interface CardPassAck {
  credentialDid: string;
  accepted: boolean;
  /** Present on failure — why the recipient could not accept/verify. */
  reason?: string;
  /** Present iff the recipient wired KB ingest — the artefact id in the recipient's partition. */
  ingestedArtefactId?: string;
}
export interface CardPassResponse {
  ack: CardPassAck;
}

/** `GET /api/card/inbound` — the pending-inbound queue (cards passed from other nodes), scoped to the session member. */
export interface InboundCardsResponse {
  inbound: CardReceivedEvent[];
}

/**
 * `POST /api/card/accept` — the member promotes a pending inbound card into their vault. Session-scoped +
 * owner-scoped + verification-gated: only the card's owner may accept, and only a `verified:true` card (a
 * cross-node card must have passed the DMZ, not merely "not found locally"). Not a co-signed act — an inward
 * accept grants nothing over anyone else; it imports the already-verified closure the Warden vetted.
 */
export interface CardAcceptRequest {
  /** The pending card to accept (its VC asset DID). */
  credentialDid: string;
}
export interface CardAcceptResponse {
  /** The vault artefact id the verified closure was promoted to. */
  artefactId: string;
}

/** SSE frame when a pending card is promoted into the vault (scoped to the owning member). */
export interface CardAcceptedEvent {
  credentialDid: string;
  artefactId: string;
  owner: string;
  acceptedAt: string;
}

/** `POST /api/card/decline` — drop a pending inbound card WITHOUT importing it. Session + owner scoped. */
export interface CardDeclineRequest {
  credentialDid: string;
}
/** SSE frame when a pending card is declined + dropped from the queue (scoped to the owning member). */
export interface CardDeclinedEvent {
  credentialDid: string;
  owner: string;
  declinedAt: string;
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

/**
 * PROVISIONAL (contract published ahead of the server wiring). A card passed from ANOTHER node arrived and
 * was verified in a DMZ (B6) — it is NOT the local `submission-stored` path (that means "my Emissary stored
 * something"). It surfaces as a distinct **pending-inbound** item, born obsidian, imported into the vault
 * only on the member's explicit accept — so the Table can render a receive surface separate from the local
 * triage queue. Emitted as SSE **`card-received`** (kebab, matching the Warden's `submission-stored` /
 * `triage-confirmed` convention). Wired in `warden control`; cross-node DMZ verification of the shipped ops
 * is a follow-up (v1 verifies via native resolvability).
 */
/**
 * How far a `verified:true` card was actually vetted — surfaced so the member's trust decision is informed:
 * - `issuer-authentic` — the chain verified AND the issuer resolves on the recipient's OWN federated
 *   gatekeeper (a real, independently-known identity).
 * - `chain-consistent` — the chain is internally consistent, but the issuer was SENDER-ASSERTED (shipped in
 *   the card's ops and verified only in the peerless DMZ, which can't resolve it fresh). A malicious sender
 *   could ship a forged issuer they control + a self-signed VC and reach this — so it is NOT "issuer trusted."
 */
export type CardAuthenticity = 'issuer-authentic' | 'chain-consistent';

export interface CardReceivedEvent {
  /** The delivered credential (VC asset) DID. */
  credentialDid: string;
  /** The schema the VC conforms to. */
  schemaDid: string;
  /** The verified deliverer (authcrypt sender) — resolve fresh; never cached as authoritative. */
  from: string;
  /** DMZ verification outcome at arrival (provenance + validity, NOT safety). */
  verified: boolean;
  /** The credential's issuer DID (from the verified closure) — surfaced for the member's trust decision. */
  issuer?: string;
  /** How far the card was vetted (see `CardAuthenticity`) — present iff `verified`. */
  authenticity?: CardAuthenticity;
  /**
   * Whether the card's PAYLOAD (claims) is readable here. False for a normal cross-node card — its content is
   * encrypted to the SENDER's audience, so the recipient holds a chain-verified PROVENANCE reference (issuer +
   * type, no claims), not readable text. A readable handover requires the sender to ship a recipient-sealed
   * rendering (a deliberate follow-up). Present iff `verified`.
   */
  contentReadable?: boolean;
  /** ISO timestamp of arrival. */
  receivedAt: string;
  /** The recipient member this inbound card is scoped to (the session DID it awaits accept from). */
  owner: string;
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
   * `spend` — approve an agent-family SPEND escalation (agent · amount · purpose · band · sensitivity).
   */
  kind: 'proof-request' | 'evidence-approval' | 'kb-action' | 'policy-signature' | 'spend';
  /** Proof-request: the challenge being answered. */
  challengeDid?: string;
  schema?: string;
  sensitivityName?: SensitivityName;
  /** Evidence approval: the Warden-authored claim being disclosed. */
  claim?: string;
  /** Evidence approval: the Warden-authored reason shown to the Sovereign (never the agent's words). */
  reason?: string;
  /** KB action / spend: the action, the resource, and a Warden-authored summary (the purpose). */
  action?: string;
  resource?: string;
  summary?: string;
  /** Spend (`kind:'spend'`): the agent asking, cost + unit, the band, and whether a 2nd factor is due.
   *  Purpose rides in `summary` (Warden-authored); `resource` is the payee/invoice; sensitivity in
   *  `sensitivityName`. */
  agent?: string;
  amount?: number;
  unit?: string;
  band?: 'standing' | 'agent' | 'parent';
  multifactor?: boolean;
  receivedAt: string;
}

/**
 * The Warden's SPEND observation feed entry (`GET /api/spend/receipts`) — the parent's passive log of
 * agent-family spends: autonomous notify-mode settlements that never entered `pending[]`, plus the
 * outcome of gated ones. Contract converged with Aegis + Sevenfold (docs/agent-family.md).
 *
 * INVARIANT the Table relies on: **`approved === false` ⇒ `paid === false`** (fail-closed — a refused or
 * unanswered spend never moves funds). `approved:true, paid:false` is the one honest non-fail-closed edge:
 * approved but the payment did not (yet) succeed.
 */
export interface SpendReceipt {
  /** The agent Sovereign that spent (or was refused). */
  agent: string;
  amount: number;
  unit?: string;
  /** The Warden-authored purpose. */
  purpose: string;
  band: 'standing' | 'agent' | 'parent';
  /** Who decided: `'standing'` (routine), `'self-notify'` (agent auto-approved), a Sovereign DID (a Signet
   *  decision — the parent or the agent), or `'timeout'` (no answer). */
  approver: string;
  approved: boolean;
  /** Did money actually move. `approved:false ⇒ paid:false`. Set by the settlement caller (the Lightning rail). */
  paid: boolean;
  /** Present when `!approved`. */
  reason?: 'declined' | 'timeout' | 'no-allowance';
  at: string;
  /** Set iff `paid` — the Lightning payment hash. */
  paymentHash?: string;
  /** Optional: the sensitivity the action touched, for the feed card. */
  sensitivityName?: SensitivityName;
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
  /**
   * How this Signet's gate authorizes control acts: `human` (a person PINs each act) or `agent` (an
   * AI-agent Sovereign self-approves within its parent-signed control-allowance, escalating above it). Lets
   * the Table render what is actually enforced instead of the honesty marker (docs/agentgate-allowance.md).
   */
  gateMode?: 'human' | 'agent';
  /**
   * Agent gate only: a summary of the ACTIVE, parent-signed control-allowance the AgentGate self-approves
   * within — so the Table shows the real bound. `bound:false` means no verified allowance is in force (a
   * child agent then escalates every above-standing control act to the parent; the ROOT agent self-approves).
   */
  controlAllowance?: {
    /** Whether a parent-signed, governor-pinned allowance is actually in force. */
    bound: boolean;
    /** The parent (governor) DID the allowance is pinned to, when a child agent is bound to one. */
    parentDid?: string;
    /** The self-approvable control acts (action + optional resource prefix), when bound. */
    selfApprove?: { action: string; resourcePrefix?: string }[];
  };
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

// ─────────────────────────────── Trinity (aggregate view) ───────────────────────────────

/** Reachability + bound identity of ONE Trinity role's control plane, so a Table can render each actor up or
 *  down independently. `did` is present only when the role answered (from its own `status.identity.did`). */
export interface TrinityRoleReachability {
  role: 'warden' | 'signet' | 'emissary';
  /** The control-plane base URL probed (e.g. http://127.0.0.1:4310). */
  url: string;
  reachable: boolean;
  did?: string;
  /** Populated when `reachable` is false — why the probe failed (for an honest "down" render). */
  error?: string;
}

/**
 * A Sovereign's full Trinity — Warden · Signet · Emissary — as one canonical "here is my Trinity" shape,
 * so every family app (each Sovereign's own Table) assembles into the SAME structure.
 *
 * There is no single Trinity server: the three run as SEPARATE control planes (Warden `4310`/`4320` ·
 * Signet `4311` · Emissary `4312`), so this is ASSEMBLED CLIENT-SIDE by reading each role's status route.
 * Each per-role status is present only when that role answered; `reach` always lists all three, so a role
 * that is down still renders as down rather than vanishing.
 *
 * NOTE — authority is NOT uniform across the Trinity's Signet: a human Signet gates with proof-of-human
 * (leveled: L1 MEDIUM/HIGH, L2 SEALED), an AI's with proof-of-agent (flat L1, self-approval). A consumer
 * rendering approvals MUST carry each approval's `method` (pin | agent) + level and never present an agent
 * self-approval as a proof-of-human co-sign. (The Signet's gate mode is not yet on `SignetStatus`; surfacing
 * it there is paired with the AgentGate allowance-enforcement work.)
 */
export interface TrinityStatus {
  /** The Sovereign this Trinity serves — human or AI. From the Warden/Emissary `sovereignDid`, or the bound
   *  identity when this Trinity IS a Sovereign's own. */
  sovereignDid?: string;
  warden?: WardenStatus;
  signet?: SignetStatus;
  emissary?: EmissaryStatus;
  reach: TrinityRoleReachability[];
}

/** Submit a captured observation to the Warden. */
export interface SubmitRequest {
  kind: string;
  /** Text observation. Required for text kinds; omit when submitting a binary `attachment` (e.g. an image). */
  text?: string;
  /**
   * A binary attachment (e.g. an image) submitted through the RELIABLE daemon path — the Emissary turns it
   * into a native Archon image asset (bytes → the node's IPFS) and ships only the sealed asset-DID reference,
   * never base64 in DIDComm. Use this instead of the racy `submit-image` CLI. Present ⇒ `kind` is `'image'`.
   */
  attachment?: WitnessAttachment;
}
export interface SubmitResponse {
  receipt: ReceiptRecord;
}

// ── Invocation: the keyless invoke-shim (Emissary daemon) + the Signet-gated grant (Sovereign daemon) ──
//
// A browser has no keymaster, so it POSTs an INTENT over local HTTP and the wallet-holding daemon runs the
// full `hearthold/invocation` ceremony. Confused-deputy-safe: the Emissary is the authcrypt sender bound to
// the capability holder, and every invoke is bound by the capability's caveats (ceiling / kinds / owner).

/** A readable summary of the minted evidence graph (the credential itself is sealed). Mirrors the core shape. */
export interface EvidenceGraphSummary {
  claim: string;
  structured?: Record<string, unknown>;
  evidence: { kind: string; observedFrom: string; observedTo: string; count: number; witnessedBy: string[]; merkleRoot: string }[];
  approved: boolean;
  validUntil: string;
  issued?: { issuer: string; credentialType: string; schema?: string }[];
  trustClass: 'witnessed' | 'composite';
}

/**
 * Emissary daemon `POST /api/invoke` — an invocation intent. The daemon fills nonce/txn/presentation from its
 * wallet + held scope capability. There is deliberately **no `recipientDid`**: the audience of a minted proof
 * is DESIGNATED by the capability (a per-audience pairwise grant), never chosen at invoke time — otherwise a
 * requester-chosen recipient reopens the confused-deputy hole. Forge-for-a-peer is a scoped grant, not a field.
 */
export interface InvokeRequest {
  /** The fact to prove. */
  claim: string;
  /** The witness kind backing it — must satisfy the capability's `caveats.kinds`. */
  kind: string;
  /** The capability operation (default `prove`), must be in `authority.operations`. */
  action?: string;
  /** The invocation target (default `hearthold:vault:<kind>`), within the capability's `resources`. */
  target?: string;
  /** Selective-disclosure leaf indices. */
  reveal?: number[];
}

/** Mirrors `hearthold/evidence-response`, minus the DIDComm envelope. Consent blocks; then granted | denied. */
export type InvokeResponse =
  | { status: 'granted'; credentialDid: string; schemaDid: string; graph?: EvidenceGraphSummary }
  | { status: 'denied'; reason: string }; // the Warden's reason string, passed through unmodified

/** Emissary daemon `POST /api/accept-capability` — accept a granted scope VC into the Emissary's wallet. */
export interface AcceptCapabilityRequest {
  credentialDid: string;
}
export interface AcceptCapabilityResponse {
  accepted: boolean;
}

/**
 * Sovereign/Signet daemon `POST /api/authorize-capability` — the Sovereign grants the Emissary a revocable
 * scope capability to PROVE facts. Signet-gated (a proof-of-human prompt), so the human sees exactly what
 * disclosure authority they are granting. Separate from `/api/delegate` (submit authority) by design.
 */
export interface AuthorizeCapabilityRequest {
  emissaryDid: string;
  /** Witness kinds the Emissary may prove (default: any). */
  kinds?: string[];
  /** Max sensitivity the capability may disclose — PUBLIC|LOW|MEDIUM|HIGH|SEALED (default LOW). */
  ceiling?: string;
  /** Invocation target (default `hearthold:vault`). */
  target?: string;
  /** Days until the capability expires (default 90). */
  days?: number;
}
export type AuthorizeCapabilityResponse =
  | { granted: true; credentialDid: string; schemaDid: string }
  | { granted: false; declined: true };

/** A grant in the Sovereign's capability inventory — the "permissions center" (Phase 4). */
export interface CapabilityGrantView {
  credentialDid: string;
  holder: string;
  target: string;
  kinds?: string[];
  ceiling: number;
  expires: string;
  issuedAt: string;
  state: 'active' | 'expired' | 'revoked';
  revokedAt?: string;
}

/** Sovereign/Signet daemon `GET /api/capabilities` — the inventory the Table mirrors read-only. */
export interface CapabilitiesResponse {
  capabilities: CapabilityGrantView[];
}

/** Sovereign/Signet daemon `POST /api/revoke-capability` — flip a grant's status bit (Warden denies at use). */
export interface RevokeCapabilityRequest {
  credentialDid: string;
}
export interface RevokeCapabilityResponse {
  revoked: boolean;
  reason?: string;
}
