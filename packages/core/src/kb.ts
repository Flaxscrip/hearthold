/**
 * Knowledge Base — authentication primitives.
 *
 * A Sovereign proves control of their DID *end-to-end* by signing the KB request over a Warden-issued
 * nonce (`keymaster.addProof` — a detached secp256k1 signature the Warden verifies against the
 * Sovereign's DID). Because the signature is the Sovereign's, a relaying Mage cannot forge the
 * requester's identity; because it covers the Warden's nonce, it can't be replayed. Authorization
 * (is this DID a KB member?) is a separate trust-registry check — see the Warden's `KbService`.
 */

import type { KeymasterHandle } from './keymaster.js';
import type { KbRequestStatement, SignedKbRequest } from './protocol.js';

/** The Sovereign signs a KB request statement with its own key. */
export async function signKbRequest(
  sovereign: KeymasterHandle,
  statement: KbRequestStatement,
): Promise<SignedKbRequest> {
  return (await sovereign.keymaster.addProof(statement)) as SignedKbRequest;
}

export interface KbSignatureCheck {
  ok: boolean;
  reason: string;
  signer?: string;
}

/**
 * The Warden verifies a signed KB request: the detached signature is valid AND made by the DID the
 * request claims as `requester`. No decryption — `verifyProof` resolves the signer's DID key.
 * (Freshness — that `nonce` is one the Warden issued and hasn't seen — is checked by the caller.)
 */
export async function verifyKbRequestSignature(
  warden: KeymasterHandle,
  signed: SignedKbRequest,
): Promise<KbSignatureCheck> {
  if (!signed || !signed.proof) return { ok: false, reason: 'request is not signed' };
  const proof = signed.proof as { verificationMethod?: string };
  const signerDid = String(proof.verificationMethod ?? '').split('#')[0] ?? '';
  if (!signerDid) return { ok: false, reason: 'no signer in proof' };
  if (signerDid !== signed.requester) return { ok: false, reason: 'signature is not by the stated requester' };

  const verifyProof = warden.keymaster.verifyProof.bind(warden.keymaster) as (o: unknown) => Promise<boolean>;
  if (!(await verifyProof(signed).catch(() => false))) {
    return { ok: false, reason: "the requester's signature does not verify" };
  }
  return { ok: true, reason: 'authenticated', signer: signerDid };
}
