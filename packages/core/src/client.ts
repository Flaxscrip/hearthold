/**
 * WardenClient — the Witness's view of the Warden, over the private HTTP channel.
 *
 * Reusable by any Witness front-end (CLI now; browser/mobile later) since it depends only on a
 * KeymasterHandle and fetch. Opens a session via the delegation challenge/response, then submits
 * sealed observations and requests evidence (handling per-request step-up for sensitive content).
 */

import type { KeymasterHandle } from './keymaster.js';
import { respondToChallenge } from './auth.js';
import { sealForWarden } from './payload.js';
import { HttpPaths, getJson, postJson, type HealthInfo } from './http.js';
import {
  PROTOCOL_VERSION,
  type WitnessKind,
  type WitnessSubmission,
  type SubmissionReceipt,
  type SessionChallenge,
  type SessionGrant,
  type EvidenceRequest,
  type EvidenceResponse,
  type StepUpProof,
} from './protocol.js';
import type { DisclosureMode } from './security.js';

export interface Observation {
  kind: WitnessKind;
  observedAt: string;
  payload: unknown;
}

/** Supplies a step-up secret/proof on demand (e.g. prompt the Sovereign for a PIN). */
export type StepUpResolver = (
  response: Extract<EvidenceResponse, { status: 'step-up-required' }>,
  witness: KeymasterHandle,
) => Promise<StepUpProof>;

export class WardenClient {
  private token?: string;
  private wardenDid?: string;

  constructor(
    private readonly witness: KeymasterHandle,
    private readonly baseUrl: string,
  ) {}

  get connectedWardenDid(): string | undefined {
    return this.wardenDid;
  }

  /** Discover the Warden and open a session (baseline STANDING tier). */
  async connect(): Promise<void> {
    const health = await getJson<HealthInfo>(this.baseUrl + HttpPaths.health);
    this.wardenDid = health.wardenDid;

    const challenge = await postJson<SessionChallenge>(this.baseUrl + HttpPaths.sessionChallenge, {});
    const responseDid = await respondToChallenge(this.witness, challenge.challengeDid);
    const grant = await postJson<SessionGrant>(this.baseUrl + HttpPaths.session, { responseDid });
    this.token = grant.token;
  }

  /** Seal an observation to the Warden and submit it. Returns the Warden's receipt. */
  async submit(obs: Observation): Promise<SubmissionReceipt> {
    if (!this.token || !this.wardenDid) throw new Error('not connected — call connect() first');

    const ciphertext = await sealForWarden(
      this.witness,
      this.wardenDid,
      JSON.stringify(obs.payload),
    );
    const submission: WitnessSubmission = {
      type: 'hearthold/witness-submission',
      version: PROTOCOL_VERSION,
      kind: obs.kind,
      observedAt: obs.observedAt,
      ciphertext,
    };
    return postJson<SubmissionReceipt>(this.baseUrl + HttpPaths.submit, submission, this.token);
  }

  /**
   * Request a selective-disclosure credential proving a claim. If the Warden demands step-up for
   * sensitive content, `resolveStepUp` is invoked to produce the proof and the request is retried.
   */
  async requestEvidence(
    claim: string,
    disclosureMode: DisclosureMode,
    resolveStepUp?: StepUpResolver,
  ): Promise<EvidenceResponse> {
    if (!this.token) throw new Error('not connected — call connect() first');

    const send = (stepUp?: StepUpProof): Promise<EvidenceResponse> => {
      const req: EvidenceRequest = {
        type: 'hearthold/evidence-request',
        version: PROTOCOL_VERSION,
        claim,
        disclosureMode,
        stepUp,
      };
      return postJson<EvidenceResponse>(this.baseUrl + HttpPaths.evidence, req, this.token);
    };

    let res = await send();
    if (res.status === 'step-up-required' && resolveStepUp) {
      const proof = await resolveStepUp(res, this.witness);
      res = await send(proof);
    }
    return res;
  }
}
