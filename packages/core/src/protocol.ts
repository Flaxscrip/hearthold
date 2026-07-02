/**
 * Hearthold wire protocol — the messages exchanged between Witness and Warden. They are carried as
 * DIDComm v2 message bodies (see transport.ts); payloads are sealed in-band as bare ciphertext
 * (see payload.ts), so nothing is anchored on a registry and the relationship is not observable.
 * The messages are transport-agnostic: the same shapes would ride any request/reply transport.
 */

import type { Sensitivity, AuthzTier, DisclosureMode } from './security.js';

export const PROTOCOL_VERSION = '0.3.0' as const;

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
  /** A step-up proof satisfying a higher tier, when the Warden demanded one. */
  stepUp?: StepUpProof;
}

/** Warden → Witness: either a granted credential, or a demand to step up authorization. */
export type EvidenceResponse =
  | {
      type: 'hearthold/evidence-response';
      version: typeof PROTOCOL_VERSION;
      status: 'granted';
      /** The minted evidence-graph credential (subject = Sovereign, issuer = Warden). */
      credentialDid: string;
      /** The schema a verifier challenges by to have this presented. */
      schemaDid: string;
    }
  | {
      type: 'hearthold/evidence-response';
      version: typeof PROTOCOL_VERSION;
      status: 'denied';
      reason: string;
    }
  | {
      type: 'hearthold/evidence-response';
      version: typeof PROTOCOL_VERSION;
      status: 'step-up-required';
      /** The tier the requester must reach to clear the artefact's sensitivity. */
      requiredTier: AuthzTier;
      /** Methods the Warden will accept to step up. */
      accepts: StepUpMethod[];
      /** A fresh challenge DID, when the demanded method is challenge/response. */
      challengeDid?: string;
      /** What the Sovereign must approve — the requester relays this to the Signet. */
      context?: StepUpContext;
    };

/** The disclosure the Sovereign is asked to approve (bound to its claim + evidence commitment). */
export interface StepUpContext {
  /** Single-use transaction id for this disclosure. */
  txn: string;
  /** The claim being disclosed. */
  claim: string;
  /** The Merkle root of the supporting evidence — the Sovereign approves *this* set. */
  evidenceRoot: string;
  /** Proof-of-human assurance level the approval must carry. */
  requiredLevel: number;
}

/** Ways a Witness can elevate authorization for sensitive content. */
export type StepUpMethod = 'challenge' | 'pin' | 'passphrase';

/** A proof supplied to satisfy a step-up demand. */
export interface StepUpProof {
  method: StepUpMethod;
  /** Response DID (for `challenge`) or the secret (for `pin`/`passphrase`). */
  value: string;
}

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
      /** The HearthholdApproval VC the Sovereign issued to the Warden. */
      approvalCredDid: string;
    }
  | {
      type: 'hearthold/approval-response';
      version: typeof PROTOCOL_VERSION;
      approved: false;
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
  | ErrorMessage;
