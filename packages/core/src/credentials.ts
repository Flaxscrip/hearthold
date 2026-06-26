import type { VerifiableCredential } from '@didcid/keymaster/types';

import type { KeymasterHandle } from './keymaster.js';
import type { WitnessKind } from './protocol.js';

/** Credential type markers used in Hearthold claims. */
export const CredentialType = {
  DELEGATION: 'HearthholdDelegation',
  ATTESTATION: 'HearthholdAttestation',
} as const;

/** Scope of authority the Warden grants the Witness. */
export interface DelegationScope {
  /** Which witness/claim kinds the Witness may request evidence about. */
  kinds: WitnessKind[];
  /** ISO timestamp after which the delegation is no longer valid. */
  validUntil: string;
}

/**
 * Warden issues a revocable delegation credential to the Witness, bound to the delegation schema
 * so challenge/response can match it. Returns the credential DID. The Warden must be the current
 * identity on `warden`.
 */
export async function issueDelegation(
  warden: KeymasterHandle,
  witnessDid: string,
  schemaDid: string,
  scope: DelegationScope,
): Promise<string> {
  const bound = await warden.keymaster.bindCredential(witnessDid, {
    schema: schemaDid,
    validUntil: scope.validUntil,
    claims: {
      type: CredentialType.DELEGATION,
      kinds: scope.kinds,
    },
  });
  return warden.keymaster.issueCredential(bound, { schema: schemaDid, validUntil: scope.validUntil });
}

/** Witness accepts a delegation credential into its wallet. */
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
 * when the Witness needs to prove something in the world.
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
