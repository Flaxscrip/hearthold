/**
 * Hearthold wire protocol — the messages exchanged between Emissary and Warden. They are carried as
 * DIDComm v2 message bodies (see transport.ts); payloads are sealed in-band as bare ciphertext
 * (see payload.ts), so nothing is anchored on a registry and the relationship is not observable.
 * The messages are transport-agnostic: the same shapes would ride any request/reply transport.
 */

import type { Sensitivity, DisclosureMode } from './security.js';
import type { CipherPublicJwk } from './payload.js';

export const PROTOCOL_VERSION = '0.4.0' as const;

/** Kinds of observation the Emissary can submit. Extended over time. */
export type WitnessKind = 'event' | 'location' | 'activity' | 'browsing' | 'document';

// ── Emissary → Warden: submission ──────────────────────────────────────────────

/** An encrypted observation to add to the vault. */
export interface WitnessSubmission {
  type: 'hearthold/witness-submission';
  version: typeof PROTOCOL_VERSION;
  kind: WitnessKind;
  /** When the thing being witnessed occurred. */
  observedAt: string;
  /** Payload sealed to the Warden's key (bare ciphertext, not anchored). */
  ciphertext: string;
  /** Optional sensitivity the Emissary proposes; the Warden's classifier decides authoritatively. */
  proposedSensitivity?: Sensitivity;
}

/** Warden → Emissary: acknowledgement of a stored submission. */
export interface SubmissionReceipt {
  type: 'hearthold/submission-receipt';
  version: typeof PROTOCOL_VERSION;
  /** Stable id of the stored artefact (content hash of the ciphertext). */
  artefactId: string;
  /** Sensitivity the Warden assigned (post-classification, or quarantine default). */
  assignedSensitivity: Sensitivity;
  storedAt: string;
}

// ── Emissary → Warden: evidence (with per-request step-up) ──────────────────────

/** Which vault artefacts back a claim — the Warden selects and summarizes them into provenance. */
export interface EvidenceClaimSpec {
  /** Artefact kind that supports the claim (e.g. `location` for a residence claim). */
  kind: WitnessKind;
  /** Inclusive lower bound on `observedAt` (ISO), if the claim is time-scoped. */
  from?: string;
  /** Inclusive upper bound on `observedAt` (ISO). */
  to?: string;
  /** Structured form of the claim, carried verbatim into the evidence graph. */
  structured?: Record<string, unknown>;
}

export interface EvidenceRequest {
  type: 'hearthold/evidence-request';
  version: typeof PROTOCOL_VERSION;
  /** The claim to be proven, e.g. "resided in FR during 2026-H1". */
  claim: string;
  /** How the requester wants the answer disclosed. */
  disclosureMode: DisclosureMode;
  /** Which artefacts back the claim (kind + optional window). Required to assemble evidence. */
  spec?: EvidenceClaimSpec;
  /** The DID the claim is about (the Sovereign). Defaults to the Warden's configured Sovereign. */
  subjectDid?: string;
  /** How long the minted proof should stay valid (`validUntil`). Defaults to the Warden's setting. */
  validForMinutes?: number;
  /** Third-party `issued` credentials (by DID) the Sovereign holds, to compose into the proof. */
  with?: string[];
  /** Selective disclosure: indices of supporting observations to reveal against the signed root (A3). */
  reveal?: number[];
}

/**
 * A readable summary of a minted evidence graph — the graph itself is encrypted to the Sovereign, so
 * the Warden hands the requester this so it can *see* what was proven without decrypting.
 */
export interface EvidenceGraphSummary {
  claim: string;
  structured?: Record<string, unknown>;
  evidence: {
    kind: WitnessKind;
    observedFrom: string;
    observedTo: string;
    count: number;
    witnessedBy: string[];
    merkleRoot: string;
  }[];
  /** Whether the Sovereign co-signed a proof-of-human approval (A2). */
  approved: boolean;
  /** When this ephemeral proof expires (`validUntil`). */
  validUntil: string;
  /** Third-party `issued` leaves composed in (external issuer + type) — the strong evidence. */
  issued?: { issuer: string; credentialType: string; schema?: string }[];
  /** Overall trust class: `witnessed`, or `composite` when issued leaves are present. */
  trustClass: 'witnessed' | 'composite';
}

/** Warden → Emissary: either the granted evidence graph, or a denial. */
export type EvidenceResponse =
  | {
      type: 'hearthold/evidence-response';
      version: typeof PROTOCOL_VERSION;
      status: 'granted';
      /** The minted evidence-graph credential (subject = Sovereign, issuer = Warden). */
      credentialDid: string;
      /** The schema a verifier challenges by to have this presented. */
      schemaDid: string;
      /** A readable summary of what was proven (the credential itself is sealed to the Sovereign). */
      graph?: EvidenceGraphSummary;
    }
  | {
      type: 'hearthold/evidence-response';
      version: typeof PROTOCOL_VERSION;
      status: 'denied';
      reason: string;
    };

// ── Prove (verifier ↔ holder) ─────────────────────────────────────────────────

/** Verifier → Holder: answer this challenge (which names the schema + trusted issuers). */
export interface ProofRequestMessage {
  type: 'hearthold/proof-request';
  version: typeof PROTOCOL_VERSION;
  challengeDid: string;
  /**
   * The (public) schema DID the challenge concerns. Lets the holder side apply its own disclosure
   * policy — e.g. the Emissary projector maps schema → sensitivity to decide act-alone vs relay. The
   * sensitivity itself is never taken from the verifier.
   */
  schema?: string;
}

/** A proof-of-human assertion the Signet produces when the Sovereign approves a disclosure. */
export interface HumanPresenceAssertion {
  method: 'pin' | 'passphrase' | 'biometric' | 'face-liveness';
  /** Assurance level (higher = stronger presence evidence), cf. NIST AAL. */
  level: number;
  timestamp: string;
}

/** Holder → Verifier: the presentation (response DID) for the verifier to verify. */
export interface ProofPresentationMessage {
  type: 'hearthold/proof-presentation';
  version: typeof PROTOCOL_VERSION;
  responseDid: string;
  /** The Signet's proof-of-human assertion for this disclosure (when gated). */
  humanProof?: HumanPresenceAssertion;
}

// ── Warden ↔ Sovereign: the direct approval channel (control plane) ───────────
//
// A sensitive disclosure is approved on a channel the WARDEN owns — the Emissary (the world-facing
// agent) is never in the authorization path (§7.7 / control-vs-data-plane separation). The Warden
// authors the description; the Sovereign approves it through the Signet.

/** What the Sovereign signs when it co-signs a disclosure — bound to the claim + evidence commitment. */
export interface EvidenceApprovalStatement {
  approver: string;
  txn: string;
  claim: string;
  evidenceRoot: string;
  humanProof: { method: string; level: number; timestamp: string };
}

/** The approval statement plus the Sovereign's own detached signature (`keymaster.addProof`). */
export type SignedEvidenceApproval = EvidenceApprovalStatement & { proof?: unknown };

/** Warden → Sovereign: approve disclosing this evidence graph (Warden-authored description). */
export interface ApprovalRequestMessage {
  type: 'hearthold/approval-request';
  version: typeof PROTOCOL_VERSION;
  /** Single-use transaction id for this disclosure. */
  txn: string;
  /** The claim about to be disclosed. */
  claim: string;
  /** Merkle root of the supporting evidence — the Sovereign approves *this* set. */
  evidenceRoot: string;
  /** Proof-of-human assurance level required for the claim's sensitivity. */
  requiredLevel: number;
  /** The Warden-authored, human-readable reason shown to the Sovereign (never the agent's words). */
  reason: string;
  /** The Sovereign the claim is about (issues the approval to the Warden). */
  subjectDid: string;
}

/** Sovereign → Warden: the signed approval (or a decline). */
export type ApprovalResponseMessage =
  | {
      type: 'hearthold/approval-response';
      version: typeof PROTOCOL_VERSION;
      approved: true;
      /** The approval statement signed by the Sovereign — embedded verbatim in the graph. */
      approval: SignedEvidenceApproval;
    }
  | {
      type: 'hearthold/approval-response';
      version: typeof PROTOCOL_VERSION;
      approved: false;
      reason: string;
    };

// ── Knowledge Base — the public Mage portal to a private Warden ───────────────
//
// An authorized Sovereign queries/updates a shared KB. The public Mage (Emissary) relays; the private
// Warden authenticates (DID control) + authorizes (trust-registry group) + serves. Authentication is
// end-to-end: the Sovereign signs the request over a Warden-issued nonce, so the relaying Mage cannot
// forge the requester's identity. This is challenge/response semantics (Warden nonce = freshness).

/** Sovereign → Warden (via Mage): "let me in" — asks for a fresh nonce to sign. */
export interface KbChallengeRequestMessage {
  type: 'hearthold/kb-challenge-request';
  version: typeof PROTOCOL_VERSION;
  kbId: string;
}

/** Warden → Sovereign (via Mage): a fresh, single-use nonce to bind the next request to. */
export interface KbChallengeMessage {
  type: 'hearthold/kb-challenge';
  version: typeof PROTOCOL_VERSION;
  nonce: string;
}

/** What the Sovereign signs — proves DID control and binds to the Warden's nonce. */
export interface KbRequestStatement {
  action: 'query' | 'update';
  /** The Sovereign's DID (must match the signature and a KB group member). */
  requester: string;
  kbId: string;
  /** The nonce the Warden issued (freshness / anti-replay). */
  nonce: string;
  /** Query: the question. */
  query?: string;
  k?: number;
  /** Update: the knowledge to contribute. */
  kind?: string;
  text?: string;
  /** KB Spaces: which partition an update targets — the shared partition or the member's own private
   *  one. Omit to use the space's default (`defaultScope`). Ignored for queries (which union the
   *  member's visible set). */
  scope?: 'shared' | 'private';
}
/** A KB request statement plus the Sovereign's detached signature (`keymaster.addProof`). */
export type SignedKbRequest = KbRequestStatement & { proof?: unknown };

/** Sovereign → Warden (via Mage): the signed query/update. */
export interface KbRequestMessage {
  type: 'hearthold/kb-request';
  version: typeof PROTOCOL_VERSION;
  request: SignedKbRequest;
}

// ── KB login: challenge/response (keys stay in the member's wallet / the Signet) ──
//
// The archon.social/login pattern. The Warden issues an Archon challenge (embedding the Mage's public
// callback); the member's wallet/Signet `createResponse`s it (proving DID control, keys never leaving
// the wallet); the Warden `verifyResponse`s and issues a short-lived session. The Mage only relays.

/** Browser → Mage → Warden: begin login; `callback` is the Mage's public URL the wallet will POST to. */
export interface KbLoginStartMessage {
  type: 'hearthold/kb-login-start';
  version: typeof PROTOCOL_VERSION;
  kbId: string;
  callback: string;
}

/** Warden → Mage → browser: the challenge DID to render as a QR / deep link. */
export interface KbLoginChallengeMessage {
  type: 'hearthold/kb-login-challenge';
  version: typeof PROTOCOL_VERSION;
  challenge: string;
}

/** Wallet → Mage callback → Warden: the signed response DID (`createResponse` output). */
export interface KbLoginCompleteMessage {
  type: 'hearthold/kb-login-complete';
  version: typeof PROTOCOL_VERSION;
  /** Which KB this login is for — routes to the KbService that minted the challenge. */
  kbId: string;
  response: string;
}

/** Warden → Mage → browser: a short-lived session bound to the authenticated DID. */
export interface KbSessionMessage {
  type: 'hearthold/kb-session';
  version: typeof PROTOCOL_VERSION;
  token: string;
  did: string;
  expiresAt: string;
  /** KB Spaces: this KB grants each member a private partition — the portal can show a shared/private
   *  contribute toggle. Absent/false = a plain shared KB (no toggle). */
  memberPartitions?: boolean;
  /** Where a scope-less contribution lands (the portal's toggle default). */
  defaultScope?: 'shared' | 'private';
}

/** Browser → Mage → Warden: a session-authenticated KB op (the token stands in for a signature). */
export interface KbSessionRequestMessage {
  type: 'hearthold/kb-session-request';
  version: typeof PROTOCOL_VERSION;
  token: string;
  kbId: string;
  action: 'query' | 'update';
  query?: string;
  k?: number;
  kind?: string;
  text?: string;
  /** KB Spaces: target the shared partition or the member's private one (update only; default per space). */
  scope?: 'shared' | 'private';
}

// ── Partition-key rewrap (Phase 2 / guardianship-threat-model §4a) ──────────────────────────────────
// The read-guest handshake. The Warden holds a member's private-partition keys wrapped to the member's
// key (it cannot open them at rest). On a member's session, the Warden asks that member's OWN Signet to
// unwrap them and rewrap them to a Warden EPHEMERAL session key, so the Warden can transiently RAG the
// member's own content. Warden ⇄ the member's Signet, both Hearthold — never an app, never the governor.
export interface PartitionRewrapRequestMessage {
  type: 'hearthold/partition-rewrap-request';
  version: typeof PROTOCOL_VERSION;
  /** Binds the rewrapped keys to one session (zeroized when it ends). */
  sessionId: string;
  /** The Warden's EPHEMERAL per-session public key — the member rewraps to it; the long-term key stays home. */
  wardenSessionPub: CipherPublicJwk;
  /** ONLY the session member's own partitions (scoped, §4.1): partitionId + its member-wrapped private key. */
  partitions: { partitionId: string; wrapped: string }[];
  /** Warden-issued single-use nonce (replay guard). */
  nonce: string;
}

export interface PartitionRewrapResponseMessage {
  type: 'hearthold/partition-rewrap-response';
  version: typeof PROTOCOL_VERSION;
  sessionId: string;
  /** False iff the member's proof-of-human failed / they declined. */
  approved: boolean;
  /** Present iff approved: each partition key rewrapped to `wardenSessionPub`. */
  rewrapped?: { partitionId: string; rewrapped: string }[];
  reason?: string;
}

// ── KB assurance step-up (factor 2): the Warden asks the member out-of-band to authorize an action ──
// This travels DIRECTLY Warden → the member's Signet — the Mage is never on this channel, so it can
// neither forge nor replay the approval. Reads never trigger it; policy (the registry) decides which
// actions do.

/** Warden → member's Signet: authorize this action? (direct control-plane channel). */
export interface KbApprovalRequestMessage {
  type: 'hearthold/kb-approval-request';
  version: typeof PROTOCOL_VERSION;
  /** The member being asked (must be the DIDComm recipient). */
  member: string;
  action: string;
  resource: string;
  /** A human-readable description of the action (Warden-authored). */
  summary: string;
}

/** Member's Signet → Warden: the out-of-band decision. */
export interface KbApprovalResponseMessage {
  type: 'hearthold/kb-approval-response';
  version: typeof PROTOCOL_VERSION;
  approved: boolean;
  reason?: string;
}

// ── Ruleset governance: the Warden asks the governing Sovereign's Signet to SIGN a policy change ──
// A compromised Warden cannot forge policy: the Sovereign signs (proof-of-human at the Signet), and
// readers pin the Sovereign's DID. Direct Warden↔Sovereign channel — no relay in the governance path.

/** Warden → Sovereign: please sign this Ruleset version (governance). Carries a human-readable summary. */
export interface RulesetSignRequestMessage {
  type: 'hearthold/ruleset-sign-request';
  version: typeof PROTOCOL_VERSION;
  /** The unsigned Ruleset the Warden constructed (next version, previous link intact). */
  ruleset: unknown;
  /** Warden-authored description shown at the Signet (e.g. "raise write on drake-kb to factor2"). */
  summary: string;
}

/** Sovereign → Warden: the signed Ruleset (approved), or a decline. */
export type RulesetSignResponseMessage =
  | { type: 'hearthold/ruleset-sign-response'; version: typeof PROTOCOL_VERSION; approved: true; signed: unknown }
  | { type: 'hearthold/ruleset-sign-response'; version: typeof PROTOCOL_VERSION; approved: false; reason: string };

/** Warden → Sovereign (via Mage): the result of an authorized KB request, or a refusal. */
export type KbResultMessage =
  | {
      type: 'hearthold/kb-result';
      version: typeof PROTOCOL_VERSION;
      action: 'query';
      answer: string;
      /** Each citation is labelled by which partition it came from — 'shared' or the member's 'private'. */
      citations: { artefactId: string; kind: string; observedAt: string; score: number; scope?: 'shared' | 'private' }[];
    }
  | {
      type: 'hearthold/kb-result';
      version: typeof PROTOCOL_VERSION;
      action: 'update';
      artefactId: string;
      /** Whether the contribution was embedded into the recall index. `false` = stored but NOT yet
       *  searchable (the embedder was unavailable); recover with `warden kb-reindex`. */
      indexed?: boolean;
    }
  | {
      type: 'hearthold/kb-error';
      version: typeof PROTOCOL_VERSION;
      reason: string;
    };

// ── CGPR relay (A2A gateway ↔ Warden) ────────────────────────────────────────
// The A2A gateway (Emissary-plane) translates an inbound A2A CgprRequestArtifact into this NEUTRAL
// internal request and relays it to the Warden over DIDComm. No A2A type crosses this channel — the
// gateway shapes CgprGrant/CgprDecision at the edge from the neutral response.

/** Gateway → Warden: a translated CGPR request (audience = the counterparty C's DID). */
export interface CgprRelayRequestMessage {
  type: 'hearthold/cgpr-request';
  version: typeof PROTOCOL_VERSION;
  audience: string;
  scopes: string[];
  purpose: string;
  validForMinutes: number;
}

/** Warden → gateway: the neutral CGPR result — the attestation VC (subject = pairwise DID), or a deny. */
export type CgprRelayResponseMessage =
  | {
      type: 'hearthold/cgpr-response';
      version: typeof PROTOCOL_VERSION;
      status: 'granted';
      credential: Record<string, unknown>;
      schemaDid: string;
      validUntil: string;
    }
  | { type: 'hearthold/cgpr-response'; version: typeof PROTOCOL_VERSION; status: 'denied'; reason: string };

/** Warden → Emissary: a request was refused (e.g. not authorized). */
export interface ErrorMessage {
  type: 'hearthold/error';
  version: typeof PROTOCOL_VERSION;
  reason: string;
}

export type HearthholdMessage =
  | WitnessSubmission
  | SubmissionReceipt
  | EvidenceRequest
  | EvidenceResponse
  | ProofRequestMessage
  | ProofPresentationMessage
  | ApprovalRequestMessage
  | ApprovalResponseMessage
  | KbChallengeRequestMessage
  | KbChallengeMessage
  | KbRequestMessage
  | KbLoginStartMessage
  | KbLoginChallengeMessage
  | KbLoginCompleteMessage
  | KbSessionMessage
  | KbSessionRequestMessage
  | PartitionRewrapRequestMessage
  | PartitionRewrapResponseMessage
  | KbApprovalRequestMessage
  | KbApprovalResponseMessage
  | RulesetSignRequestMessage
  | RulesetSignResponseMessage
  | KbResultMessage
  | CgprRelayRequestMessage
  | CgprRelayResponseMessage
  | ErrorMessage;
