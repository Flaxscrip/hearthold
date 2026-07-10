/**
 * In-band artefact payload encryption — zero registry footprint.
 *
 * The Emissary encrypts each observation directly to the Warden's public key using the low-level
 * cipher, producing a bare ciphertext string. That ciphertext travels in the HTTP body over the
 * private (Tailscale) channel and is stored locally by the Warden — nothing is anchored on any
 * registry, so neither the payload nor the Emissary↔Warden relationship is ever observable.
 */

import type { KeymasterHandle } from './keymaster.js';

/** Stable content id for an artefact, derived from its ciphertext. */
export function contentId(ciphertext: string, cipher: KeymasterHandle['cipher']): string {
  return cipher.hashMessage(ciphertext);
}

/** Emissary seals a plaintext payload to the Warden's DID. Returns bare ciphertext (not anchored). */
export async function sealForWarden(
  witness: KeymasterHandle,
  wardenDid: string,
  plaintext: string,
): Promise<string> {
  const doc = await witness.keymaster.resolveDID(wardenDid);
  const wardenPub = witness.keymaster.getPublicKeyJwk(doc);
  return witness.cipher.encryptMessage(wardenPub, plaintext);
}

/** Warden unseals a ciphertext addressed to it, using its current id's key. */
export async function unsealAsWarden(warden: KeymasterHandle, ciphertext: string): Promise<string> {
  // Must be the current-id keypair (matches the publicKeyJwk in the Warden's DID doc that the
  // Emissary sealed to) — NOT the wallet's root HD keypair.
  const keys = await warden.keymaster.fetchKeyPair();
  if (!keys) throw new Error('warden has no current-id keypair');
  return warden.cipher.decryptMessage(keys.privateJwk, ciphertext);
}
