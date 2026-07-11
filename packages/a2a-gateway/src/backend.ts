/**
 * The backend seam — how the gateway reaches the Sovereign's Warden.
 *
 * The gateway holds no secrets: it translates an inbound CGPR request into this neutral internal shape
 * and hands it to a backend. In production the backend relays over DIDComm to the Warden's CGPR service;
 * in tests it calls that service in-process. Either way the result is neutral — the gateway shapes it
 * into a `CgprGrant`/`CgprDecision` at the edge, so no A2A type reaches the Warden.
 */

/** The gateway's internal request (translated from `CgprRequestArtifact`; carries no A2A types). */
export interface CgprGatewayRequest {
  /** The counterparty (C) — its DID; the pairwise mint audience and grant recipient. */
  audience: string;
  scopes: string[];
  purpose: string;
  validForMinutes: number;
}

export interface CgprBackendGrant {
  status: 'granted';
  /** The attestation VC (subject = a fresh pairwise DID). */
  credential: Record<string, unknown>;
  schemaDid: string;
  validUntil: string;
}
export interface CgprBackendDeny {
  status: 'denied';
  reason: string;
}
export type CgprBackendResult = CgprBackendGrant | CgprBackendDeny;

export interface CgprBackend {
  submit(req: CgprGatewayRequest): Promise<CgprBackendResult>;
}
