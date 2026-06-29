/**
 * Decentralized Trust Graph (DTG) credentials on Archon — prototype.
 *
 * DTG (ToIP / First Person Network, repo `trustoverip/dtgwg-cred-tf`) defines six W3C-VC-2.0 types
 * subtyping an abstract `DTGCredential`. This module prototypes two of them on Archon keymaster:
 *
 *   - **VRC** RelationshipCredential — a relationship edge (issuer R-DID → subject R-DID)
 *   - **VWC** WitnessCredential — a third-party attestation that an edge was established, issued by a
 *     Witness DID (W-DID), carrying `digest` (hash of the witnessed VRC) + `witnessContext`.
 *
 * The interesting question for Archon is whether we can shape a credential to the DTG type hierarchy:
 * `bindCredential` returns a full credential object and `issueCredential` accepts a partial one, so we
 * mutate `type` + `@context` on the bound credential before issuing and then read it back to see what
 * the node actually persisted. See docs/trust-graph-and-delegation.md §8 (Q#2).
 */

import { createHash } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';

/** W3C VC Data Model 2.0 context (Archon credentials are 2.0-shaped: validFrom/validUntil). */
export const W3C_VC2_CONTEXT = 'https://www.w3.org/ns/credentials/v2';
/** The DTG credentials context (First Person Network). */
export const DTG_CONTEXT = 'https://firstperson.network/credentials/dtg/v1';

/** DTG concrete subtypes (the abstract parent is `DTGCredential`). */
export const DtgType = {
  BASE: 'DTGCredential',
  RELATIONSHIP: 'RelationshipCredential', // VRC
  MEMBERSHIP: 'MembershipCredential', // VMC
  INVITATION: 'InvitationCredential', // VIC
  PERSONA: 'PersonaCredential', // VPC
  ENDORSEMENT: 'EndorsementCredential', // VEC
  WITNESS: 'WitnessCredential', // VWC
} as const;

/** Context of a witnessing event (DTG VWC `witnessContext`). */
export interface WitnessContext {
  /** Human-readable event name, e.g. "Drake Island raid form-up". */
  event?: string;
  /** Session or nonce identifier — the Witness-as-session-recorder anchor. */
  sessionId?: string;
  /** Verification method used, e.g. "virtual-realtime" | "in-person-proximity". */
  method?: string;
}

/**
 * A permissive-but-shaped DTG schema for a credential type: declares the DTG subject fields so the
 * schema documents the shape, while staying open (additionalProperties) for forward-compat.
 */
export function dtgSchema(subtype: string): unknown {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: subtype,
    type: 'object',
    properties: {
      digest: { type: 'string' },
      witnessContext: {
        type: 'object',
        properties: {
          event: { type: 'string' },
          sessionId: { type: 'string' },
          method: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    // The DTG subtype lives in the top-level `type` array, not in credentialSubject.
    additionalProperties: true,
  };
}

/** Canonical JSON (sorted keys) — a stand-in for RFC 8785 JCS, sufficient for a stable digest. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(',');
  return `{${body}}`;
}

/**
 * DTG VWC `digest`: a SHA-256 over the witnessed credential's canonical form. The DTG example encodes
 * it `sha256:<hex>`; the prose calls for a multibase multihash — we match the example here and note
 * the multihash refinement in the design doc.
 */
export function credentialDigest(vc: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(vc)).digest('hex')}`;
}

/**
 * Shape the @context to the DTG set: keep VC2, add the DTG context, and drop the node's default
 * `…/credentials/examples/v2` (an Archon bindCredential default that should not ship on a real DTG
 * credential). No duplicates.
 */
function withDtgContext(context: string[] | undefined): string[] {
  const base = (context ?? [W3C_VC2_CONTEXT]).filter((c) => !c.includes('/credentials/examples/'));
  const out = [...base];
  for (const c of [W3C_VC2_CONTEXT, DTG_CONTEXT]) if (!out.includes(c)) out.push(c);
  return out;
}

/**
 * Issue a DTG credential of `subtype` to `subjectDid`, shaping the bound credential to the DTG type
 * hierarchy + context before issuing. `claims` become credentialSubject fields (alongside `id`).
 * Returns the credential DID. The issuer must be the current identity on `issuer`.
 */
export async function issueDtgCredential(
  issuer: KeymasterHandle,
  subjectDid: string,
  subtype: string,
  schemaDid: string,
  claims: Record<string, unknown> = {},
  validUntil?: string,
): Promise<string> {
  const bound = await issuer.keymaster.bindCredential(subjectDid, {
    schema: schemaDid,
    validUntil,
    claims,
  });
  // Shape to the DTG type hierarchy + context. The subtype lives only in the top-level `type` array
  // (DTG-faithful), not in credentialSubject. The node round-trips both (verified by the prototype).
  bound.type = ['VerifiableCredential', DtgType.BASE, subtype];
  bound['@context'] = withDtgContext(bound['@context']);
  return issuer.keymaster.issueCredential(bound, { validUntil });
}

/** Issue a DTG Relationship Credential (VRC): a relationship edge to `targetDid`. */
export async function issueVrc(
  issuer: KeymasterHandle,
  targetDid: string,
  schemaDid: string,
  validUntil?: string,
): Promise<string> {
  return issueDtgCredential(issuer, targetDid, DtgType.RELATIONSHIP, schemaDid, {}, validUntil);
}

/**
 * Issue a DTG Witness Credential (VWC): the Witness (current identity on `witness`, the W-DID) attests
 * it observed an edge involving `observedDid`, optionally digesting the witnessed VRC and recording
 * the session context.
 */
export async function issueVwc(
  witness: KeymasterHandle,
  observedDid: string,
  schemaDid: string,
  opts: { witnessedVrc?: unknown; witnessContext?: WitnessContext; validUntil?: string } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.witnessedVrc !== undefined) claims.digest = credentialDigest(opts.witnessedVrc);
  if (opts.witnessContext) claims.witnessContext = opts.witnessContext;
  return issueDtgCredential(witness, observedDid, DtgType.WITNESS, schemaDid, claims, opts.validUntil);
}
