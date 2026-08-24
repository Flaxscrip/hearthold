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

// ── Member-key partitions (guardianship-threat-model.md §0/§4a) ────────────────────────────────────
//
// A member's PRIVATE partition is sealed to a per-partition keypair, NOT to the Warden. Because the
// cipher is ECDH-ES (sealing needs only the recipient's PUBLIC key), the Warden can hold the partition
// public key and keep WRITING private submissions to it — a "write-host" — while being unable to DECRYPT
// them at rest. The partition PRIVATE key is wrapped to the member's DID key (`wrapKeyForDid`); only the
// member can unwrap it, and on login their Signet rewraps it to a Warden ephemeral session key so the
// Warden can transiently RAG the member's own content (the read-guest role, wired in Phase 2). A rooted
// governor reading another member's partition at rest gets ciphertext it cannot open.

/** A cipher public key (recipient of a seal). Derived from the cipher API so we don't couple to @didcid/cipher. */
export type CipherPublicJwk = Parameters<KeymasterHandle['cipher']['encryptMessage']>[0];
/** A cipher private key (holder of a seal). */
export type CipherPrivateJwk = Parameters<KeymasterHandle['cipher']['decryptMessage']>[0];
export interface CipherKeypair {
  publicJwk: CipherPublicJwk;
  privateJwk: CipherPrivateJwk;
}

/** Mint a fresh partition keypair. The Warden keeps the public half (write-host); the private half is wrapped to the member. */
export function generatePartitionKeypair(cipher: KeymasterHandle['cipher']): CipherKeypair {
  return cipher.generateRandomJwk();
}

/** Seal a plaintext to a raw recipient public key (a partition key). Bare ciphertext; zero registry footprint. */
export function sealToKey(cipher: KeymasterHandle['cipher'], recipientPub: CipherPublicJwk, plaintext: string): string {
  return cipher.encryptMessage(recipientPub, plaintext);
}

/** Open a ciphertext with a held private key (e.g. a per-session rewrapped partition key). */
export function openWithKey(cipher: KeymasterHandle['cipher'], recipientPriv: CipherPrivateJwk, ciphertext: string): string {
  return cipher.decryptMessage(recipientPriv, ciphertext);
}

/** Wrap a partition private key to a recipient DID's key — only the holder of that DID's key can unwrap it. */
export async function wrapKeyForDid(handle: KeymasterHandle, recipientDid: string, privateJwk: CipherPrivateJwk): Promise<string> {
  const doc = await handle.keymaster.resolveDID(recipientDid);
  const pub = handle.keymaster.getPublicKeyJwk(doc);
  return handle.cipher.encryptMessage(pub, JSON.stringify(privateJwk));
}

/** Unwrap a wrapped partition private key with the holder's current-id key (the member, at their Signet). */
export async function unwrapKey(handle: KeymasterHandle, wrapped: string): Promise<CipherPrivateJwk> {
  const keys = await handle.keymaster.fetchKeyPair();
  if (!keys) throw new Error('no current-id keypair to unwrap the partition key');
  return JSON.parse(handle.cipher.decryptMessage(keys.privateJwk, wrapped)) as CipherPrivateJwk;
}
