/**
 * Star Hold — the City Key (κ) import + verification primitive.
 *
 * PrivacyMage's Star system addresses a "City Key" by a content hash it calls **κ**:
 *   κ = "sha256:" + hex(SHA-256(UTF-8(canonicalCityJSON(key without top-level `kappa`))))
 * This is the Hearthold side of the seam agreed in Flaxscrip/hearthold#90:
 * **the Star presents; Hearthold verifies and enforces.** This file is the "verifies" foot of
 * that seam — importing a presented City Key and re-deriving its κ so nothing downstream trusts a
 * key by the name it carries. Enforcement (the bound-signer challenge and the Warden release gate)
 * builds on top of this and lives with the Emissary/Warden, not here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICALIZATION IS NOT JCS. Do not route κ through a credential-suite canonicalizer.
 * PrivacyMage was explicit (#90): "don't substitute a credential suite's canonicalizer for it."
 * κ uses the *City canonicalization profile* — a recursive key-sort, array order preserved, no
 * whitespace, the `kappa` field excluded from its own preimage — which is a DIFFERENT layer from
 * the W3C JCS (RFC 8785) canonicalization Hearthold uses for credential signatures. Two keys must
 * never be conflated: κ over the City profile; the credential proof over JCS. `canonicalCityJSON`
 * below is a verbatim port of PrivacyMage's authoritative reference (`mitchuski/star`
 * sigil/index.html · Law L5), so κ re-derived here is byte-identical to the Star's origin.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * IMPORT ≠ CONTROL. Re-deriving κ proves the key's *content integrity* — that it is what it says —
 * and nothing more. κ identifies a content state, not a controller (#90). A verified City Key is
 * still an unauthenticated stranger until a bound-signer challenge is answered by the key's bound
 * Ed25519 signer. Callers MUST NOT treat a passing `verifyCityKey` as authentication or admission.
 */

import { createHash } from 'node:crypto';

/** The Star's content-hash label: `sha256:<64-lowercase-hex>`. */
export type Kappa = `sha256:${string}`;

/**
 * A City Key (v1). Known base fields are typed; everything additive (geometry, walks, packet
 * commitments, identity, lineage, `holds`, and anything not yet named) is preserved verbatim via the
 * index signature and MUST survive a round trip — it is part of the κ preimage. Never drop or
 * reshape an unknown field; a view change must not rewrite κ (SHAPE ≠ VIEW, #90).
 */
export interface StarCityKey {
  version: 1;
  name?: string;
  palette?: { cool?: string; warm?: string; sword?: string; mage?: string };
  descriptions?: unknown;
  /** The stamped content label, if the key was exported already named. Excluded from its own preimage. */
  kappa?: Kappa;
  /** κ of the parent key — content lineage. `prior` is content and stays in the preimage. */
  prior?: Kappa | null;
  /** The Hold commitment (`agentprivacy.star-hold/1`): Merkle root + count of retained signed records. */
  holds?: { root: string; count: number };
  [additive: string]: unknown;
}

/**
 * The City canonicalization profile (PrivacyMage Law L5), ported verbatim:
 *  - primitives → `JSON.stringify(v)` (standard JSON scalar encoding);
 *  - arrays → order preserved, elements canonicalized;
 *  - objects → keys sorted (default lexicographic), `"key":value` joined by `,`, no whitespace.
 * Hearthold runs the same JS/Node `JSON.stringify` + `Array.prototype.sort` as the reference client,
 * so this produces byte-identical output for the same value.
 */
export function canonicalCityJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalCityJSON).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalCityJSON(obj[k]))
      .join(',') +
    '}'
  );
}

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/**
 * Re-derive a City Key's κ. The top-level `kappa` is excluded from its own preimage (a shallow
 * delete on a clone — never mutates the caller's key); everything else, including `prior` and every
 * unknown additive field, stays in.
 */
export function deriveKappa(key: StarCityKey): Kappa {
  const preimage: Record<string, unknown> = { ...key };
  delete preimage.kappa;
  return `sha256:${sha256Hex(canonicalCityJSON(preimage))}`;
}

export type CityKeyVerdict =
  /** κ was stamped and re-derives to the same value — the key is what it says it is. */
  | { status: 'authentic'; derived: Kappa; claimed: Kappa }
  /** No κ was stamped — the key "learns its name" here; content-consistent but not self-attested. */
  | { status: 'unnamed'; derived: Kappa; claimed: null }
  /** κ was stamped but does NOT match the content — reject. */
  | { status: 'mismatch'; derived: Kappa; claimed: Kappa };

/**
 * Verify a presented City Key's content integrity by re-deriving κ and comparing it to the stamped
 * label. Mirrors the reference client's three verdicts. This is CONTENT integrity only — a passing
 * result is not authentication and not admission (see IMPORT ≠ CONTROL in the file header).
 */
export function verifyCityKey(key: StarCityKey): CityKeyVerdict {
  const derived = deriveKappa(key);
  const claimed = typeof key.kappa === 'string' && key.kappa.startsWith('sha256:') ? key.kappa : null;
  if (claimed === null) {
    return { status: 'unnamed', derived, claimed: null };
  }
  // κ is a public content address, not a secret — a plain constant compare is sufficient; there is
  // no timing channel worth defending because the "secret" is derivable from the bytes in hand.
  return claimed === derived
    ? { status: 'authentic', derived, claimed }
    : { status: 'mismatch', derived, claimed };
}

/**
 * The Tracing Protocol (Law L5, `proof` excluded instead of `kappa`): a packet's proof re-derives
 * over its own canonical form with the `proof` field removed. Used to check a bearer's proof packets
 * against a Hold / packets commitment.
 */
export function derivePacketProof(packet: Record<string, unknown>): Kappa {
  const preimage = { ...packet };
  delete preimage.proof;
  return `sha256:${sha256Hex(canonicalCityJSON(preimage))}`;
}

/**
 * Merkle root of a set of packet proofs, matching the reference client:
 *   leaves filtered to non-empty strings and sorted lexicographically once; each round combines
 *   pairs as sha256("left|right") (the "sha256:"-prefixed strings joined by "|"), an odd tail is
 *   promoted unchanged. Returns the root as a κ-label, or null for an empty set.
 *
 * Conformance vector (from the reference client): the three leaves sha256(utf8 "packet-alpha"),
 * sha256(utf8 "packet-beta"), sha256(utf8 "packet-gamma") yield the root
 * sha256:07f20f689c8bef2d8a9a2a71d94e7014ea8398cc603b0ff72dadba5c517983d1
 */
export function packetsDigest(proofs: string[]): Kappa | null {
  let level = proofs.filter((p) => typeof p === 'string' && p.length > 0).sort();
  if (level.length === 0) {
    return null;
  }
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(`sha256:${sha256Hex(level[i]! + '|' + level[i + 1]!)}`);
      } else {
        next.push(level[i]!);
      }
    }
    level = next;
  }
  return level[0] as Kappa;
}
