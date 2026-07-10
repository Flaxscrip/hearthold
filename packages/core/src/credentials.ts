import type { VerifiableCredential } from '@didcid/keymaster/types';

import type { KeymasterHandle } from './keymaster.js';
import type { WitnessKind } from './protocol.js';

/** Credential type markers used in Hearthold claims. */
export const CredentialType = {
  DELEGATION: 'HearthholdDelegation',
  ATTESTATION: 'HearthholdAttestation',
} as const;

/** Scope of authority the Warden grants the Emissary. */
export interface DelegationScope {
  /** Which witness/claim kinds the Emissary may request evidence about. */
  kinds: WitnessKind[];
  /** ISO timestamp after which the delegation is no longer valid. */
  validUntil: string;
}

/**
 * Warden issues a revocable delegation credential to the Emissary, bound to the delegation schema
 * so challenge/response can match it. Returns the credential DID. The Warden must be the current
 * identity on `warden`.
 */
export async function issueDelegation(
  warden: KeymasterHandle,
  emissaryDid: string,
  schemaDid: string,
  scope: DelegationScope,
): Promise<string> {
  const bound = await warden.keymaster.bindCredential(emissaryDid, {
    schema: schemaDid,
    validUntil: scope.validUntil,
    claims: {
      type: CredentialType.DELEGATION,
      kinds: scope.kinds,
    },
  });
  return warden.keymaster.issueCredential(bound, { schema: schemaDid, validUntil: scope.validUntil });
}

/**
 * Issue a credential of arbitrary claims to a subject, bound to `schemaDid`. The issuer must be the
 * current identity on `issuer`. Returns the credential DID. (This is how a Sovereign acts as an
 * issuer — e.g. a guild manager issuing membership or raid tickets to gamers.)
 */
export async function issueClaim(
  issuer: KeymasterHandle,
  subjectDid: string,
  schemaDid: string,
  claims: Record<string, unknown>,
  validUntil?: string,
): Promise<string> {
  const bound = await issuer.keymaster.bindCredential(subjectDid, { schema: schemaDid, validUntil, claims });
  return issuer.keymaster.issueCredential(bound, { schema: schemaDid, validUntil });
}

/** Accept any credential issued to this identity into its wallet. */
export async function acceptCredential(
  handle: KeymasterHandle,
  credentialDid: string,
): Promise<boolean> {
  return handle.keymaster.acceptCredential(credentialDid);
}

/** Emissary accepts a delegation credential into its wallet. */
export async function acceptDelegation(
  witness: KeymasterHandle,
  credentialDid: string,
): Promise<boolean> {
  return witness.keymaster.acceptCredential(credentialDid);
}

/** Warden revokes a previously issued credential (delegation or attestation). */
export async function revokeCredential(
  warden: KeymasterHandle,
  credentialDid: string,
): Promise<boolean> {
  return warden.keymaster.revokeCredential(credentialDid);
}

/**
 * Mint a selective-disclosure attestation: a derived credential asserting a fact about the
 * Sovereign's history WITHOUT exposing the source artefact. This is what crosses the boundary
 * when the Emissary needs to prove something in the world.
 */
export async function mintAttestation(
  warden: KeymasterHandle,
  subjectDid: string,
  claim: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const bound = await warden.keymaster.bindCredential(subjectDid, {
    claims: {
      type: CredentialType.ATTESTATION,
      claim,
      ...fields,
    },
  });
  return warden.keymaster.issueCredential(bound);
}

/** Fetch and return a stored credential, or null. */
export async function getCredential(
  handle: KeymasterHandle,
  credentialDid: string,
): Promise<VerifiableCredential | null> {
  return handle.keymaster.getCredential(credentialDid);
}
