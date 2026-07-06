/**
 * Hearthold wire protocol — the messages exchanged between Witness and Warden. They are carried as
 * DIDComm v2 message bodies (see transport.ts); payloads are sealed in-band as bare ciphertext
 * (see payload.ts), so nothing is anchored on a registry and the relationship is not observable.
 * The messages are transport-agnostic: the same shapes would ride any request/reply transport.
 */

import type { Sensitivity, DisclosureMode } from './security.js';

export const PROTOCOL_VERSION = '0.4.0' as const;

/** Kinds of observation the Witness can submit. Extended over time. */
export type WitnessKind = 'event' | 'location' | 'activity' | 'browsing' | 'document';

// ── Witness → Warden: submission ──────────────────────────────────────────────

/** An encrypted observation to add to the vault. */
export interface WitnessSubmission {
  type: 'hearthold/witness-submission';
  version: typeof PROTOCOL_VERSION;
  kind: WitnessKind;
  /** When the thing being witnessed occurred. */
  observedAt: string;
  /** Payload sealed to the Warden's key (bare ciphertext, not anchored). */
  ciphertext: string;
  /** Optional sensitivity the Witness proposes; the Warden's classifier decides authoritatively. */
  proposedSensitivity?: Sensitivity;
}

/** Warden → Witness: acknowledgement of a stored submission. */
export interface SubmissionReceipt {
  type: 'hearthold/submission-receipt';
  version: typeof PROTOCOL_VERSION;
  /** Stable id of the stored artefact (content hash of the ciphertext). */
  artefactId: string;
  /** Sensitivity the Warden assigned (post-classification, or quarantine default). */
  assignedSensitivity: Sensitivity;
  storedAt: string;
}

// ── Witness → Warden: evidence (with per-request step-up) ──────────────────────

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

/** Warden → Witness: either the granted evidence graph, or a denial. */
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
   * policy — e.g. the Witness projector maps schema → sensitivity to decide act-alone vs relay. The
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
// A sensitive disclosure is approved on a channel the WARDEN owns — the Witness (the world-facing
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
// An authorized Sovereign queries/updates a shared KB. The public Mage (Witness) relays; the private
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
  response: string;
}

/** Warden → Mage → browser: a short-lived session bound to the authenticated DID. */
export interface KbSessionMessage {
  type: 'hearthold/kb-session';
  version: typeof PROTOCOL_VERSION;
  token: string;
  did: string;
  expiresAt: string;
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
}

/** Warden → Sovereign (via Mage): the result of an authorized KB request, or a refusal. */
export type KbResultMessage =
  | {
      type: 'hearthold/kb-result';
      version: typeof PROTOCOL_VERSION;
      action: 'query';
      answer: string;
      citations: { artefactId: string; kind: string; observedAt: string; score: number }[];
    }
  | {
      type: 'hearthold/kb-result';
      version: typeof PROTOCOL_VERSION;
      action: 'update';
      artefactId: string;
    }
  | {
      type: 'hearthold/kb-error';
      version: typeof PROTOCOL_VERSION;
      reason: string;
    };

/** Warden → Witness: a request was refused (e.g. not authorized). */
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
  | KbResultMessage
  | ErrorMessage;
