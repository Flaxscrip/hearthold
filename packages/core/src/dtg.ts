/**
 * Decentralized Trust Graph (DTG) credentials on Archon.
 *
 * DTG (ToIP / First Person Network, repo `trustoverip/dtgwg-cred-tf`) defines six W3C-VC-2.0 types
 * subtyping an abstract `DTGCredential`, plus one Verifiable Data Structure. This module implements the
 * full set on Archon keymaster:
 *
 *   - **VRC** RelationshipCredential — a relationship edge (issuer R-DID → subject R-DID)
 *   - **VMC** MembershipCredential — membership of an entity in a community (C-DID → M-DID)
 *   - **VIC** InvitationCredential — authorizes onboarding a prospective member
 *   - **VPC** PersonaCredential — links a persona (P-DID) to a relationship
 *   - **VEC** EndorsementCredential — endorses a skill/reputation of the subject
 *   - **VWC** WitnessCredential — third-party attestation of an edge, by a Witness DID (W-DID)
 *   - **RCard** RelationshipCard — a VDS (human-readable jCard), NOT a `DTGCredential` subtype
 *
 * Shaping technique: `bindCredential` returns a full credential object and `issueCredential` accepts a
 * partial one, so we mutate `type` + `@context` on the bound credential before issuing. The node
 * round-trips the DTG type hierarchy, custom @context, and nested credentialSubject (verified live —
 * see docs/trust-graph-and-delegation.md §8).
 */

import { createHash } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import type { SignedRuleset } from './ruleset.js';
import {
  resolvePairwiseDid,
  isPairwiseDid,
  enforcePairwiseSubject,
  enforceKeyCustody,
  type PairwiseStore,
} from './pairwise.js';

/** W3C VC Data Model 2.0 context (Archon credentials are 2.0-shaped: validFrom/validUntil). */
export const W3C_VC2_CONTEXT = 'https://www.w3.org/ns/credentials/v2';
/** W3C VC Data Model 1.1 context — accepted inbound (verify fallback), never issued. */
export const W3C_VC1_CONTEXT = 'https://www.w3.org/2018/credentials/v1';
/** The DTG credentials context (First Person Network). */
export const DTG_CONTEXT = 'https://firstperson.network/credentials/dtg/v1';

/**
 * VC 1.1 → 2.0 verify fallback (DTG v0.3 SHOULD). Accept a v1.1-shaped DTG credential on the verifier
 * path by mapping only the fields that moved: the 2018 context → the 2.0 context, `issuanceDate` →
 * `validFrom`, `expirationDate` → `validUntil`. Same schemas, same `type` hierarchy — a non-destructive
 * normalized copy. Issue 2.0 only; this is inbound compatibility for credentials minted by other DTG
 * implementations. A credential already in 2.0 shape passes through unchanged.
 */
export function mapVc11ToVc2<T extends Record<string, unknown>>(cred: T): T {
  const out: Record<string, unknown> = { ...cred };
  const raw = out['@context'];
  const ctx = Array.isArray(raw) ? [...(raw as string[])] : raw ? [raw as string] : [];
  const mapped = ctx.map((c) => (c === W3C_VC1_CONTEXT ? W3C_VC2_CONTEXT : c));
  if (!mapped.includes(W3C_VC2_CONTEXT)) mapped.unshift(W3C_VC2_CONTEXT);
  out['@context'] = mapped;
  if ('issuanceDate' in out && !('validFrom' in out)) {
    out.validFrom = out.issuanceDate;
    delete out.issuanceDate;
  }
  if ('expirationDate' in out && !('validUntil' in out)) {
    out.validUntil = out.expirationDate;
    delete out.expirationDate;
  }
  return out as T;
}

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

/** RCard is a Verifiable Data Structure, implemented as a W3C VC but NOT a `DTGCredential` subtype. */
export const RCARD_TYPE = 'RelationshipCard';

/** Context of a witnessing event (DTG VWC `witnessContext`). */
export interface WitnessContext {
  /** Human-readable event name, e.g. "Example Sphere raid form-up". */
  event?: string;
  /** Session or nonce identifier — the Emissary-as-session-recorder anchor. */
  sessionId?: string;
  /** Verification method used, e.g. "virtual-realtime" | "in-person-proximity". */
  method?: string;
}

/**
 * A permissive-but-shaped DTG schema for a credential type: declares the DTG subject fields so the
 * schema documents the shape, while staying open (additionalProperties) for forward-compat.
 */
export function dtgSchema(subtype: string): unknown {
  // credentialSubject shapes vary by subtype (digest+witnessContext for VWC, endorsement for VEC,
  // card for RCard, bare id for VRC/VMC); the subtype itself lives in the top-level `type` array, so
  // the schema documents the union of fields and stays open (additionalProperties). Archon's
  // createSchema requires a non-empty `properties` object.
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: subtype,
    type: 'object',
    properties: {
      digest: { type: 'string' },
      witnessContext: { type: 'object', additionalProperties: true },
      endorsement: { type: 'object', additionalProperties: true },
      card: { type: 'array' },
    },
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
  /** Extra top-level `type` tokens (e.g. a non-authoritative PHC hint appended to a VMC). */
  extraTypes: string[] = [],
): Promise<string> {
  const bound = await issuer.keymaster.bindCredential(subjectDid, {
    schema: schemaDid,
    validUntil,
    claims,
  });
  // Shape to the DTG type hierarchy + context. The subtype lives only in the top-level `type` array
  // (DTG-faithful), not in credentialSubject. The node round-trips both (verified by the prototype).
  bound.type = ['VerifiableCredential', DtgType.BASE, subtype, ...extraTypes];
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
 * Issue a VRC to a counterparty under **Unilateral Relationship Identification** (DTG v0.3, H1): the
 * issuer presents a FRESH per-counterparty **R-DID** (pairwise from its own perspective) as the
 * credential's issuer, never its stable M-DID. Each counterparty ⇒ a distinct R-DID, so two edges from
 * the same entity are unlinkable at the wire. The R-DID→issuer linkage is Warden-private (the injected
 * `PairwiseStore`).
 *
 * The R-DID-per-relationship MUST is enforced here (`enforcePairwiseSubject`): the stable M-DID
 * bootstrapping path (`bootstrapMdid`) is refused unless the active Ruleset carries a signed
 * `stableDidAudiences` exception for the counterparty. Returns the credential DID and the R-DID used.
 */
export async function issueVrcToCounterparty(
  issuer: KeymasterHandle,
  store: PairwiseStore,
  args: {
    counterparty: string;
    schemaDid: string;
    /** The issuer's stable identity the R-DID stands in for (linkage; never disclosed). */
    issuerDid: string;
    activeRuleset: SignedRuleset | null;
    /** The Sovereign's key-custody policy (`enforceKeyCustody`); defaults to `activeRuleset`. If it marks
     *  `counterparty` subject-keyed, a non-Sovereign issuer may not mint a fresh R-DID for it. */
    keyCustodyRuleset?: SignedRuleset | null;
    createdAt: string;
    registry?: string;
    validUntil?: string;
    /** Bootstrapping: issue from this stable M-DID instead of an R-DID (needs a Ruleset exception). */
    bootstrapMdid?: string;
  },
): Promise<{ credentialDid: string; issuerDid: string; pairwise: boolean }> {
  const km = issuer.keymaster;
  let asName: string | null = null;
  let identityDid: string;
  let pairwise: boolean;

  if (args.bootstrapMdid) {
    identityDid = args.bootstrapMdid;
    pairwise = await isPairwiseDid(store, identityDid);
  } else {
    // Key-custody chokepoint (fail closed): a non-Sovereign issuer may not mint an R-DID for a
    // relationship the Sovereign chose to key itself.
    const custody = enforceKeyCustody({
      ruleset: args.keyCustodyRuleset ?? args.activeRuleset,
      audience: args.counterparty,
      mintedBy: issuer.role === 'sovereign' ? 'subject' : 'warden',
    });
    if (!custody.ok) throw new Error(custody.reason);
    const rec = await resolvePairwiseDid(issuer, store, {
      audience: args.counterparty,
      subjectDid: args.issuerDid,
      createdAt: args.createdAt,
      registry: args.registry,
    });
    identityDid = rec.pairwiseDid;
    asName = rec.name;
    pairwise = true;
  }

  const gate = enforcePairwiseSubject({
    subjectDid: identityDid,
    audience: args.counterparty,
    isPairwise: pairwise,
    activeRuleset: args.activeRuleset,
  });
  if (!gate.ok) throw new Error(gate.reason);

  // Issue AS the R-DID: the VRC's issuer is the R-DID, its subject the counterparty. Restore the
  // wallet's prior current id afterwards so this never leaves the issuer parked on a pairwise id.
  const prev = await km.getCurrentId().catch(() => undefined);
  if (asName) await km.setCurrentId(asName);
  try {
    const credentialDid = await issueVrc(issuer, args.counterparty, args.schemaDid, args.validUntil);
    return { credentialDid, issuerDid: identityDid, pairwise };
  } finally {
    if (asName && prev) await km.setCurrentId(prev);
  }
}

/**
 * Issue a DTG Witness Credential (VWC): the Emissary (current identity on `witness`, the W-DID) attests
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

/**
 * Issue a DTG Membership Credential (VMC): the community (current identity on `community`, the C-DID)
 * attests `memberDid` belongs to it. A complete edge is a bidirectional pair (one each direction).
 */
export async function issueVmc(
  community: KeymasterHandle,
  memberDid: string,
  schemaDid: string,
  validUntil?: string,
  /** DTG v0.3 optional PHC hint: append 'PersonhoodCredential' when the community's governance warrants
   *  it (non-authoritative per spec — a hint, not a proof of personhood). */
  opts: { personhood?: boolean } = {},
): Promise<string> {
  const extraTypes = opts.personhood ? ['PersonhoodCredential'] : [];
  return issueDtgCredential(community, memberDid, DtgType.MEMBERSHIP, schemaDid, {}, validUntil, extraTypes);
}

/** Issue a DTG Invitation Credential (VIC): authorizes `prospectDid` to join (onboarding). */
export async function issueVic(
  issuer: KeymasterHandle,
  prospectDid: string,
  schemaDid: string,
  validUntil?: string,
): Promise<string> {
  return issueDtgCredential(issuer, prospectDid, DtgType.INVITATION, schemaDid, {}, validUntil);
}

/** A DTG endorsement (VEC `endorsement` object): a skill or reputation claim. */
export interface Endorsement {
  /** e.g. 'SkillEndorsement'. */
  type: string;
  /** e.g. 'Raid Leadership'. */
  name: string;
  /** e.g. 'expert'. */
  competencyLevel?: string;
  [key: string]: unknown;
}

/** Issue a DTG Endorsement Credential (VEC): the endorser vouches for a skill/reputation of `subjectDid`. */
export async function issueVec(
  endorser: KeymasterHandle,
  subjectDid: string,
  schemaDid: string,
  endorsement: Endorsement,
  validUntil?: string,
): Promise<string> {
  return issueDtgCredential(endorser, subjectDid, DtgType.ENDORSEMENT, schemaDid, { endorsement }, validUntil);
}

/** Issue a DTG Persona Credential (VPC): link a persona (the issuer's P-DID) to a relationship counterparty. */
export async function issueVpc(
  persona: KeymasterHandle,
  counterpartyDid: string,
  schemaDid: string,
  validUntil?: string,
): Promise<string> {
  return issueDtgCredential(persona, counterpartyDid, DtgType.PERSONA, schemaDid, {}, validUntil);
}

/** A jCard (RFC 7095) array — human-readable contact/identity data. */
export type JCard = unknown[];

/**
 * Issue a DTG RCard (Relationship Card) — a Verifiable Data Structure (NOT a `DTGCredential` subtype),
 * carrying human-readable contact data as a jCard in `credentialSubject.card`.
 */
export async function issueRCard(
  publisher: KeymasterHandle,
  counterpartyDid: string,
  schemaDid: string,
  card: JCard,
  validUntil?: string,
): Promise<string> {
  const bound = await publisher.keymaster.bindCredential(counterpartyDid, {
    schema: schemaDid,
    validUntil,
    claims: { card },
  });
  // RCard is a VDS: type is ["VerifiableCredential", "RelationshipCard"] — no DTGCredential parent.
  bound.type = ['VerifiableCredential', RCARD_TYPE];
  bound['@context'] = withDtgContext(bound['@context']);
  return publisher.keymaster.issueCredential(bound, { validUntil });
}
