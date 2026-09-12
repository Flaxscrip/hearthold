/**
 * Star Hold — bound-signer verification & challenge (the "import ≠ control" enforcement).
 *
 * Slice 1 (`star-key.ts`) proves a City Key's CONTENT integrity by re-deriving κ. That is not
 * authentication: κ identifies a content state, not a controller (#90). This file closes the gap —
 * it establishes that a presenter actually CONTROLS the Ed25519 signer bound to that κ, in two steps:
 *
 *   1. verifyVtaRecord — check PrivacyMage's `agentprivacy.vta/1` bearer attestation: an Ed25519
 *      signature over the canonical record fields, binding a bearer's Ed25519 key (→ its did:key) to
 *      a κ state. This is a *bearer attestation*, deliberately NOT a delegation / context-grant /
 *      expiry receipt (#90 — keep those layers separate).
 *   2. verifyBoundSignerChallenge — a LIVE nonce, minted by the Warden, signed by that same bound
 *      key. A valid record alone is replayable; the challenge proves control *now*.
 *
 * The full chain a gate relies on: verified κ (slice 1) → a VTA record binding an Ed25519 key to
 * THAT κ → a fresh challenge signed by that key ⇒ the presenter controls the identity bound to the
 * key bound to the κ. Only then may enforcement (slice 3, the Warden gate) admit anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ASSUMPTIONS PENDING A FIXTURE. PrivacyMage's `record.js` verifier is in a private repo, so two
 * wire details are taken from the #90 spec and MUST be locked against a signed fixture before we
 * rely on them in production: (a) the canonical preimage uses the City profile canonicalizer (same
 * Law L5 as κ — the whole system uses one canonicalizer); (b) `sig`/`publicKeyHex` are lowercase
 * hex. Both are isolated below (vtaPreimage / decodeEd25519*) so locking them is a one-line change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';

import { canonicalCityJSON, type Kappa } from './star-key.js';

/** PrivacyMage's `agentprivacy.vta/1` bearer attestation. The seven fields below are the signed
 * preimage (with defaults); `sig` is the Ed25519 signature over it; `did`, if present, is checked. */
export interface VtaRecord {
  kind: string;
  /** The bearer's Ed25519 public key, 32 bytes as lowercase hex. */
  publicKeyHex: string;
  /** The κ this record attests the bearer against. */
  kappa: Kappa;
  prior?: Kappa | null;
  /** ISO timestamp. */
  at?: string;
  walks?: number;
  /** Verifiable relationship credentials (opaque here). */
  vrcs?: unknown[];
  /** Ed25519 signature over vtaPreimage(record), lowercase hex (assumption — see file header). */
  sig: string;
  /** Optional claimed did:key; if present it must equal the key-derived did:key. */
  did?: string;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58btc (Bitcoin alphabet), for did:key multibase encoding. */
function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * did:key for an Ed25519 public key: `did:key:z` + base58btc(0xed 0x01 || pubkey). This is the W3C
 * did:key standard (multicodec ed25519-pub), so it interoperates with any conforming implementation.
 */
export function ed25519PublicKeyToDidKey(publicKeyHex: string): string {
  const pub = hexToBytes(publicKeyHex);
  if (pub.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  const prefixed = new Uint8Array(2 + 32);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(pub, 2);
  return 'did:key:z' + base58btcEncode(prefixed);
}

/** Build a Node KeyObject for raw Ed25519 public-key bytes, via JWK (no DER hand-assembly). */
function ed25519PublicKeyObject(publicKeyHex: string) {
  const pub = hexToBytes(publicKeyHex);
  if (pub.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  const x = Buffer.from(pub).toString('base64url');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

/** Verify a raw Ed25519 signature (hex) over a message string by a hex public key. */
export function verifyEd25519(publicKeyHex: string, message: string, sigHex: string): boolean {
  let key, sig: Uint8Array;
  try {
    key = ed25519PublicKeyObject(publicKeyHex);
    sig = hexToBytes(sigHex);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  try {
    return cryptoVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

/**
 * The signed preimage of a VTA record: the seven canonical fields with the reference defaults
 * (`prior`→null, `walks`→0, `vrcs`→[]), canonicalized with the City profile (Law L5), `sig`/`did`
 * excluded. See the file header for why this canonicalizer and not JCS.
 */
export function vtaPreimage(record: VtaRecord): string {
  return canonicalCityJSON({
    kind: record.kind,
    publicKeyHex: record.publicKeyHex,
    kappa: record.kappa,
    prior: record.prior ?? null,
    at: record.at,
    walks: record.walks ?? 0,
    vrcs: record.vrcs ?? [],
  });
}

export type VtaVerdict =
  | { ok: true; did: string; publicKeyHex: string; kappa: Kappa }
  | { ok: false; reason: 'bad-signature' | 'did-mismatch' | 'malformed' };

/**
 * Verify an `agentprivacy.vta/1` bearer attestation: the Ed25519 signature over the canonical
 * preimage, and (if the record carries a claimed `did`) that it matches the key-derived did:key.
 * A pass establishes the bound signer — it is NOT admission (that needs the live challenge below).
 */
export function verifyVtaRecord(record: VtaRecord): VtaVerdict {
  let did: string;
  try {
    if (!record.publicKeyHex || !record.sig || !record.kappa) return { ok: false, reason: 'malformed' };
    did = ed25519PublicKeyToDidKey(record.publicKeyHex);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (record.did !== undefined && record.did !== did) return { ok: false, reason: 'did-mismatch' };
  if (!verifyEd25519(record.publicKeyHex, vtaPreimage(record), record.sig)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true, did, publicKeyHex: record.publicKeyHex, kappa: record.kappa };
}

/**
 * A Warden-minted challenge. Bound to a κ and an audience so a response cannot be replayed to a
 * different key or a different relationship; `exp` bounds its lifetime. The Warden also enforces
 * single-use (burn the nonce on redemption) — that store lives with the gate (slice 3); this file
 * provides the primitive and the expiry check.
 */
export interface BoundSignerChallenge {
  nonce: string;
  kappa: Kappa;
  audience: string;
  /** Epoch ms after which the challenge is dead. */
  exp: number;
}

export function issueBoundSignerChallenge(params: {
  kappa: Kappa;
  audience: string;
  ttlMs?: number;
  now?: number;
}): BoundSignerChallenge {
  const now = params.now ?? Date.now();
  return {
    nonce: randomBytes(32).toString('hex'),
    kappa: params.kappa,
    audience: params.audience,
    exp: now + (params.ttlMs ?? 120_000),
  };
}

/** The exact bytes a responder must sign — the whole challenge, canonicalized (Law L5). */
export function challengePreimage(challenge: BoundSignerChallenge): string {
  return canonicalCityJSON({
    nonce: challenge.nonce,
    kappa: challenge.kappa,
    audience: challenge.audience,
    exp: challenge.exp,
  });
}

export type BoundSignerVerdict =
  | { ok: true; did: string; kappa: Kappa }
  | { ok: false; reason: 'bad-record' | 'kappa-mismatch' | 'expired' | 'bad-response' };

/**
 * The bound-signer challenge check — the heart of "import ≠ control". Passes only if:
 *   (1) the VTA record verifies (bound signer established);
 *   (2) the record attests the SAME κ the challenge was issued for;
 *   (3) the challenge has not expired;
 *   (4) the response is a valid Ed25519 signature over the challenge preimage by the record's key.
 * A pass means the presenter controls the identity bound to the κ — the precondition every Warden
 * gate must require before admitting anything.
 */
export function verifyBoundSignerChallenge(params: {
  record: VtaRecord;
  challenge: BoundSignerChallenge;
  responseSigHex: string;
  now?: number;
}): BoundSignerVerdict {
  const record = verifyVtaRecord(params.record);
  if (!record.ok) return { ok: false, reason: 'bad-record' };
  if (record.kappa !== params.challenge.kappa) return { ok: false, reason: 'kappa-mismatch' };
  const now = params.now ?? Date.now();
  if (now > params.challenge.exp) return { ok: false, reason: 'expired' };
  if (!verifyEd25519(record.publicKeyHex, challengePreimage(params.challenge), params.responseSigHex)) {
    return { ok: false, reason: 'bad-response' };
  }
  return { ok: true, did: record.did, kappa: record.kappa };
}
