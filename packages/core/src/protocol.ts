/**
 * Hearthold wire protocol — the messages exchanged between Witness and Warden over the private
 * (Tailscale) HTTP channel. Payloads are sealed in-band as bare ciphertext (see payload.ts);
 * nothing is anchored on a registry, so the Witness↔Warden relationship is never observable.
 */

import type { Sensitivity, AuthzTier, DisclosureMode } from './security.js';

export const PROTOCOL_VERSION = '0.2.0' as const;

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

// ── Session handshake (challenge/response → token) ─────────────────────────────

/** Warden → Witness: a challenge to be answered to open a session. */
export interface SessionChallenge {
  challengeDid: string;
}

/** Witness → Warden: the response proving DID control + delegation. */
export interface SessionRequest {
  responseDid: string;
}

/** Warden → Witness: an opened session, scoped to the baseline STANDING tier. */
export interface SessionGrant {
  token: string;
  /** The authorization tier this session establishes without step-up. */
  tier: AuthzTier;
  expiresAt: string;
}

// ── Witness → Warden: evidence (with per-request step-up) ──────────────────────

export interface EvidenceRequest {
  type: 'hearthold/evidence-request';
  version: typeof PROTOCOL_VERSION;
  /** The claim to be proven, e.g. "resided in FR during 2026-H1". */
  claim: string;
  /** How the requester wants the answer disclosed. */
  disclosureMode: DisclosureMode;
  /** A step-up proof satisfying a higher tier, when the Warden demanded one. */
  stepUp?: StepUpProof;
}

/** Warden → Witness: either a granted credential, or a demand to step up authorization. */
export type EvidenceResponse =
  | {
      type: 'hearthold/evidence-response';
      version: typeof PROTOCOL_VERSION;
      status: 'granted';
      credentialDid: string;
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
    };

/** Ways a Witness can elevate authorization for sensitive content. */
export type StepUpMethod = 'challenge' | 'pin' | 'passphrase';

/** A proof supplied to satisfy a step-up demand. */
export interface StepUpProof {
  method: StepUpMethod;
  /** Response DID (for `challenge`) or the secret (for `pin`/`passphrase`). */
  value: string;
}

export type HearthholdMessage =
  | WitnessSubmission
  | SubmissionReceipt
  | EvidenceRequest
  | EvidenceResponse;
