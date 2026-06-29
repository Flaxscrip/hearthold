/**
 * The prove flow.
 *
 * For an `issued` claim ("I hold a valid credential of type X from issuer Y"), the proof is an
 * Archon challenge/response presentation:
 *
 *   - the **verifier** issues a challenge stating the credential schema it requires and the issuers
 *     it trusts (this is the audience binding — a fresh, verifier-bound, single-use challenge);
 *   - the **holder** (the Sovereign, who accepted the credential) presents it — the Sovereign's act
 *     of presenting *is* the external-disclosure approval;
 *   - the verifier verifies: `verifyResponse` confirms the held credential was issued by a trusted
 *     issuer and discloses its claims, which the verifier reads.
 *
 * Trust rests on the **original issuer's** signature (trust-class `issued`), not on the Warden.
 * Derived/witnessed claims (the Warden assembling a minted evidence graph) build on top of this.
 */

import type { KeymasterHandle } from './keymaster.js';

export interface ProofRequest {
  /** Credential schema (DID) the verifier requires. */
  schema: string;
  /** Issuer DIDs the verifier trusts to assert this. */
  trustedIssuers: string[];
}

/** A credential disclosed to the verifier, with its claims and (trusted) issuer. */
export interface DisclosedCredential {
  credentialDid: string;
  issuer: string;
  trustClass: 'issued';
  claims: Record<string, unknown>;
}

export interface ProofResult {
  ok: boolean;
  responder?: string;
  disclosed: DisclosedCredential[];
  reason?: string;
}

/** Verifier: create a challenge requiring a credential of `schema` from a trusted issuer. */
export async function requestProof(verifier: KeymasterHandle, req: ProofRequest): Promise<string> {
  return verifier.keymaster.createChallenge({
    credentials: [{ schema: req.schema, issuers: req.trustedIssuers }],
  });
}

/** Holder (Sovereign): present the held credential in response to the verifier's challenge. */
export async function presentProof(holder: KeymasterHandle, challengeDid: string): Promise<string> {
  return holder.keymaster.createResponse(challengeDid);
}

/**
 * Verifier: verify the response, then read the disclosed evidence. Returns the disclosed
 * credentials (claims + issuer) and whether the proof holds — every leaf issued by a trusted
 * issuer, the challenge satisfied, and any `requiredClaims` present.
 */
export async function verifyProof(
  verifier: KeymasterHandle,
  responseDid: string,
  opts: { trustedIssuers: string[]; requiredClaims?: Record<string, unknown> },
): Promise<ProofResult> {
  const res = await verifier.keymaster.verifyResponse(responseDid);

  const creds = res.credentials ?? [];
  const vps = (res.vps ?? []) as Array<{
    issuer?: string;
    credentialSubject?: Record<string, unknown>;
  }>;
  const disclosed: DisclosedCredential[] = vps.map((vp, i) => {
    const claims = { ...(vp.credentialSubject ?? {}) };
    delete (claims as { id?: unknown }).id;
    return {
      credentialDid: creds[i]?.vc ?? '',
      issuer: String(vp.issuer ?? ''),
      trustClass: 'issued',
      claims,
    };
  });

  const fail = (reason: string): ProofResult => ({ ok: false, responder: res.responder, disclosed, reason });

  if (!res.match || res.fulfilled < res.requested || res.requested === 0) {
    return fail('challenge not satisfied');
  }
  if (!disclosed.every((d) => opts.trustedIssuers.includes(d.issuer))) {
    return fail('disclosed credential is from an untrusted issuer');
  }
  if (opts.requiredClaims) {
    const required = opts.requiredClaims;
    const satisfied = disclosed.some((d) =>
      Object.entries(required).every(([k, v]) => d.claims[k] === v),
    );
    if (!satisfied) return fail('required claims not present');
  }
  return { ok: true, responder: res.responder, disclosed };
}
