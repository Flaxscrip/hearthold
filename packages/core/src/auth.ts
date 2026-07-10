/**
 * Hearthold authorization handshake.
 *
 * The trust relationship between Warden and Emissary is realized as an Archon challenge/response
 * keyed on the delegation credential:
 *
 *   1. Warden issues a HearthholdDelegation VC to the Emissary (see credentials.ts).
 *   2. Emissary accepts it into its wallet.
 *   3. Warden creates a CHALLENGE that requires a delegation VC issued by itself.
 *   4. Emissary creates a RESPONSE, proving control of its DID and possession of the delegation.
 *   5. Warden verifies the response.
 *
 * A verified response satisfies the CHALLENGE authorization tier (see security.ts).
 */

import type { KeymasterHandle } from './keymaster.js';
import { currentIdentity } from './identity.js';

/** Result of verifying a Emissary's challenge response. */
export interface VerifiedHandshake {
  /** True only if every required credential was fulfilled and the response matched. */
  verified: boolean;
  /** DID of the responding Emissary, when present. */
  responderDid?: string;
  /** How many credentials the challenge required. */
  requested: number;
  /** How many the response actually fulfilled. */
  fulfilled: number;
}

/**
 * Warden creates a challenge that requires a delegation credential, issued by the Warden itself,
 * conforming to the delegation schema. Returns the challenge DID for the Emissary to answer.
 * The Warden must be the current identity on the handle.
 */
export async function createDelegationChallenge(
  warden: KeymasterHandle,
  schemaDid: string,
): Promise<string> {
  const issuer = await currentIdentity(warden);
  if (!issuer) throw new Error('warden has no current identity');

  return warden.keymaster.createChallenge({
    credentials: [{ schema: schemaDid, issuers: [issuer.did] }],
  });
}

/**
 * Emissary answers a challenge, gathering matching credentials from its wallet and proving control
 * of its DID. Returns the response DID. The Emissary must be the current identity on the handle.
 */
export async function respondToChallenge(
  witness: KeymasterHandle,
  challengeDid: string,
): Promise<string> {
  return witness.keymaster.createResponse(challengeDid);
}

/** Warden verifies a Emissary's response. A verified result clears the CHALLENGE tier. */
export async function verifyChallengeResponse(
  warden: KeymasterHandle,
  responseDid: string,
): Promise<VerifiedHandshake> {
  const res = await warden.keymaster.verifyResponse(responseDid);
  return {
    verified: res.match && res.fulfilled >= res.requested && res.requested > 0,
    responderDid: res.responder,
    requested: res.requested,
    fulfilled: res.fulfilled,
  };
}
