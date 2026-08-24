/**
 * Hearthold capabilities — the *authorization* layer that lets the Emissary HOLD and INVOKE authority,
 * instead of being recognized by identity (an ACL lookup keyed on the DIDComm sender). See
 * `docs/invocation.md` for the full design and `docs/attributions.md` for prior-art credits.
 *
 * This is Phase 0: the type surface + pure attenuation predicates. No I/O, no keymaster, no behavior
 * change. Issuance, the invocation reference monitor, and consent discharge land in later phases.
 *
 * Prior art this composes / adapts (tracked in docs/attributions.md):
 *   - Object-capability model & "designation ≡ authority": Alan H. Karp (HP Labs; W3C public-credentials).
 *     A capability fuses designation and authorization into one unforgeable token — which is precisely why
 *     a confused deputy cannot arise. Karp's concrete recommendation — that an authorization carry a
 *     REQUIRED type distinguishing it from a `credential` — is `AUTHORIZATION_TYPE` below.
 *   - Capability data model (root/delegated, monotonic attenuation, invocation-vs-delegation): ZCAP-LD,
 *     W3C-CCG Authorization Capabilities for Linked Data (`capabilityNarrows`, `targetWithin`).
 *   - Third-party caveats / discharge (consent as a caveat discharged by a DESIGNATED party, bound to the
 *     specific invocation so it cannot be replayed): Birgisson, Politz, Erlingsson, Taly, Vrable,
 *     Lentczner — "Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the
 *     Cloud", NDSS 2014 (`ThirdPartyCaveat`, `Discharge`, the txn binding).
 *   - The verifier-enforced attenuation chain over Archon Asset DIDs it builds on is Hearthold's own
 *     `attenuation.ts` (`AuthoritySet` / `isSubset` / `verifyAttenuationChain`).
 */

import type { Sensitivity } from './security.js';
import type { AuthoritySet, AuthoritySetPayload } from './attenuation.js';
import { isSubset } from './attenuation.js';
import { PROTOCOL_VERSION } from './protocol.js';

/**
 * Karp's required type: an authorization is NOT a credential. Kept explicit so a grant can never be
 * confused with an attribute assertion (his exact recommendation to the W3C VC community). A capability
 * VC's `type` array carries this marker alongside `VerifiableCredential`.
 */
export const AUTHORIZATION_TYPE = 'HearthholdAuthorization' as const;

/** The authorization sub-type. Reserved for future kinds; today every Hearthold authorization is a capability. */
export type AuthorizationType = 'capability';

// ── The capability object ───────────────────────────────────────────────────────────────────────────────

/**
 * A macaroon-style third-party caveat: authority is conditional on a proof DISCHARGED by another party.
 * `by` designates the approver — it is NEVER supplied by the requester, which is the structural cure for
 * the confused-deputy step-up (the requester cannot name itself as its own approver).
 */
export interface ThirdPartyCaveat {
  /** The DID that must discharge this caveat (e.g. the data owner's Signet). */
  by: string;
  /** What the discharging party must attest (e.g. `"cosign(act)"`). */
  predicate: string;
  /** Optional hint to where the discharger is reached. */
  location?: string;
}

/** A W3C-style revocation pointer for a capability — the Sovereign's status list + this cap's own index. */
export interface CapabilityStatus {
  statusListCredential: string;
  statusListIndex: number;
}

/** Hearthold-specific constraints layered on the `AuthoritySet` — the caveats of a capability. */
export interface Caveats {
  /** Max artefact sensitivity this capability may disclose (≤ parent). Numeric, per `Sensitivity`. */
  ceiling: Sensitivity;
  /**
   * Witness kinds this capability may disclose (the compartment, e.g. `['location']`). Enforced at
   * invocation against the requested `spec.kind`. Absent ⇒ any kind (use with care — prefer explicit kinds).
   */
  kinds?: string[];
  /**
   * WHOSE data this authority is over — the owner scoping the Warden enforces at invocation. Designated by
   * the capability, never by a request field (closes the whole-vault `store.list()` leak and finding A).
   */
  owner?: string;
  /** If set, the disclosure is bound to this recipient DID (forge-for-a-recipient). */
  audience?: string;
  /** Expiry (ISO 8601, UTC `Z`). Must be ≤ parent and ≤ the Warden's policy cap. */
  expires?: string;
  /** Burn after a single invocation. */
  singleUse?: boolean;
  /** Consent caveats — each discharged by the party it designates, bound to the invocation `txn`. */
  requiresDischarge?: ThirdPartyCaveat[];
  /** Revocation pointer, bound into the commitment (so a holder cannot strip it to dodge the status check). */
  status?: CapabilityStatus;
}

/**
 * A Hearthold capability — the semantic object carried in a `HearthholdAuthorization` VC's
 * `credentialSubject`. The core authority is an `AuthoritySet` (operations = allowed actions, resources =
 * targets/kinds); `caveats` add Hearthold's sensitivity/owner/consent constraints.
 */
export interface HearthholdCapability {
  authorizationType: AuthorizationType;
  /** Opaque id (`urn:uuid:…`). */
  id: string;
  /** Who may invoke / further-delegate this capability (the holder — e.g. the Emissary). */
  controller: string;
  /** The parent capability this was delegated from; absent on a root capability. */
  parentCapability?: string;
  /** The resource this authority applies to (e.g. `hearthold:vault:<scope>`); attenuation may only narrow. */
  invocationTarget: string;
  /** The core authority: `operations` ⊇ requested action, `resources` ⊇ requested target/kind. */
  authority: AuthoritySet;
  /** Hearthold caveats (sensitivity ceiling, owner scoping, consent discharge, expiry, single-use). */
  caveats: Caveats;
}

/** The VC wrapper: a capability is issued as a Verifiable Credential typed `authorization`. */
export interface HearthholdCapabilityCredential {
  /** MUST include `'VerifiableCredential'` and `AUTHORIZATION_TYPE`. */
  type: string[];
  credentialSubject: HearthholdCapability;
  /** did:cid `credentialStatus` pointer for revocation (checked fail-closed at invocation). */
  credentialStatus?: { id: string; type: string };
  issuer?: string;
  validUntil?: string;
  proof?: unknown;
}

// ── The invocation act ───────────────────────────────────────────────────────────────────────────────

/** The specific act being authorized — the signed object, bound to a Warden-minted nonce. */
export interface InvocationAct {
  /** The operation, which must be in the capability's `authority.operations`. */
  action: string;
  /** The resource/target, which must sit within `invocationTarget` and `authority.resources`. */
  target: string;
  /** Action arguments (e.g. reveal indices, validForMinutes, recipient). */
  args?: Record<string, unknown>;
  /** The Warden-minted nonce this act is bound to (freshness / anti-replay). */
  nonce: string;
  /** Correlates the act, the invocation proof, and any discharges. */
  txn: string;
}

/** A discharge of a third-party caveat — bound to the invocation `txn` so it cannot be replayed. */
export interface Discharge {
  /** Which caveat this discharges (matches a `ThirdPartyCaveat.by` on the capability). */
  by: string;
  /** The predicate the human approved (must match the caveat's `predicate` — so a discharge for one
   *  predicate cannot satisfy a caveat requiring another). */
  predicate?: string;
  /** The `txn` this discharge is bound to (the macaroon `PrepareForRequest` binding). */
  txn: string;
  /**
   * The Warden-minted request digest this discharge is bound to (over claim/kind/owner/audience/sensitivity —
   * `dischargeDigest`). The Signet signs OVER it; the monitor recomputes it from the actual act. So a discharge
   * obtained for one disclosure cannot be substituted onto another under the same txn (audit-4 §1).
   */
  digest?: string;
  /** The achieved proof-of-human level, attested by the discharging Signet (not the requester). */
  level?: number;
  proof?: unknown;
}

/**
 * The multi-hop presentation: instead of a single Sovereign-issued VC, the presenter discloses a whole
 * attenuation CHAIN (`Sovereign → … → leaf`) and proves control of the leaf holder. The Warden walks the
 * chain by public resolution (`verifyCapabilityChain`, zero decryption), binds the caller to the
 * chain-attested `holder` via `holderProof`, and enforces the commitment-bound leaf authority + caveats —
 * never a wire body. See docs/multihop-delegation.md. Coexists with single-hop `presentation`.
 */
export interface ChainPresentation {
  /** The leaf hop's Asset DID — the chain is walked from here to the Sovereign root. */
  leafVcDid: string;
  /** Every hop's revealed `{authoritySet, salt, caveats}`, keyed by Asset DID (`discloseChain` output). Under
   *  enforcement every hop must be present, so authority + caveats are bound to each hop's commitment. */
  disclosed: Record<string, AuthoritySetPayload>;
  /** The leaf holder's signed proof of control over a FRESH Warden-minted challenge, bound to THIS invocation
   *  (the chain analog of the single-hop challenge/response: freshness + holder binding in one). */
  holderProof: SignedHolderProof;
}

/** The leaf holder's signature over a Warden challenge, binding a chain presentation to this invocation. */
export interface SignedHolderProof {
  type: 'hearthold/chain-holder-proof';
  /** The Warden-minted challenge this proof answers (gated single-use — anti-replay / audience binding). */
  challenge: string;
  /** Must equal the presented `leafVcDid` (binds the proof to this chain). */
  leafVcDid: string;
  /** Must equal `act.txn` (binds the proof to this specific invocation). */
  txn: string;
  /** `keymaster.addProof` output — `proof.verificationMethod` names the signer, checked === the chain holder. */
  proof?: { verificationMethod: string; proofValue: string; created: string; [k: string]: unknown };
}

/** Emissary → Warden: exercise a held capability against a specific act. */
export interface CapabilityInvocation {
  type: 'hearthold/invocation';
  version: typeof PROTOCOL_VERSION;
  /**
   * SINGLE-HOP: the capability presentation — a `createResponse` DID answering the Warden's credential-requesting
   * challenge. In one Archon ceremony it presents the Sovereign-issued scope VC AND proves the caller
   * controls its subject (holder). There is no separate, forgeable capability body: the Warden reads the
   * scope from the VERIFIED presentation (`verifyResponse`), issuer-trusted and holder-controlled. Optional
   * only because a multi-hop invocation carries `chain` instead; exactly one of the two is present.
   */
  presentation?: string;
  /** MULTI-HOP: the disclosed attenuation chain + leaf holder proof (mutually exclusive with `presentation`). */
  chain?: ChainPresentation;
  /** The act being authorized. */
  act: InvocationAct;
  /** Discharges for any `requiresDischarge` caveats on the presented capability. */
  discharges?: Discharge[];
}

// ── Pure attenuation predicates (types-only phase: no I/O) ──────────────────────────────────────────────

/** Is this a well-typed authorization (Karp's type guard — never treat a credential as a capability)? */
export function isAuthorizationCredential(vc: { type?: unknown }): boolean {
  return Array.isArray(vc.type) && vc.type.includes(AUTHORIZATION_TYPE);
}

/** ZCAP-style target attenuation: equal, or a path/query/scope extension of the parent target. */
export function targetWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(`${parent}/`) || child.startsWith(`${parent}?`) || child.startsWith(`${parent}:`);
}

/** ISO-8601 lexical compare is chronological for UTC `Z` timestamps; guard nulls (absent = no bound). */
function expiresWithin(child: string | undefined, parent: string | undefined): boolean {
  if (!parent) return true; // parent unbounded → child may set any expiry
  if (!child) return false; // parent bounded but child unbounded → widening; reject
  return child <= parent; // child must not outlive parent
}

/**
 * Does `child`'s caveat set only NARROW `parent`'s? Monotonic attenuation across Hearthold's dimensions:
 *   - `ceiling`: child ≤ parent (numeric `Sensitivity`)
 *   - `owner`: immutable once set (a delegate cannot retarget whose data it reaches)
 *   - `audience`: parent unset → child may bind one; parent set → child must equal
 *   - `expires`: child ≤ parent (a delegate may not outlive its grant)
 *   - `kinds`: parent unset (any) → child may set any; parent bounded → child must be bounded AND ⊆ parent
 *     (a delegate cannot add a witness kind it was not granted — the compartment only narrows)
 *   - `singleUse` / `status`: monotonic — a child may not remove a burn-once constraint nor a revocation pointer
 *   - `requiresDischarge`: child ⊇ parent (a delegate may ADD consent gates, never remove one)
 * The `AuthoritySet` subset is `isSubset` (attenuation.ts); this covers the caveats it does not.
 */
export function caveatsNarrow(child: Caveats, parent: Caveats): boolean {
  // Ceiling must be NUMERIC at both ends and only narrow. A missing/non-numeric ceiling is a widening escape
  // (`undefined > 1` is false), so reject it at EVERY hop — not only at the leaf shape check (audit-5).
  if (typeof child.ceiling !== 'number' || typeof parent.ceiling !== 'number') return false;
  if (child.ceiling > parent.ceiling) return false;
  if (parent.owner !== undefined && child.owner !== parent.owner) return false;
  if (parent.audience !== undefined && child.audience !== parent.audience) return false;
  if (!expiresWithin(child.expires, parent.expires)) return false;
  // A delegate may not REMOVE a burn-once constraint, nor drop the revocation pointer a parent carried
  // (can't become permanently irrevocable under a revocable ancestor). Both are monotonic like requiresDischarge.
  if (parent.singleUse && !child.singleUse) return false;
  if (parent.status !== undefined && child.status === undefined) return false;
  // Kind compartment: a bounded parent may only be narrowed — the child must be bounded and every child kind
  // must appear in the parent's set. An unbounded (absent) parent is "any", so any child set narrows it. Without
  // this a delegate could ADD a witness kind it was never granted (multi-hop kinds-widening escape).
  if (parent.kinds !== undefined) {
    if (child.kinds === undefined) return false; // child 'any' would widen a bounded parent
    if (!child.kinds.every((k) => parent.kinds!.includes(k))) return false;
  }
  const parentDischarges = parent.requiresDischarge ?? [];
  const childKeys = new Set((child.requiresDischarge ?? []).map((c) => `${c.by}::${c.predicate}`));
  return parentDischarges.every((p) => childKeys.has(`${p.by}::${p.predicate}`));
}

/**
 * Full attenuation predicate for one delegation hop: is `child` a legal narrowing of `parent`? Combines the
 * `AuthoritySet` subset (`isSubset`), invocation-target narrowing, caveat narrowing, and the parent-pointer
 * link. This is the per-hop rule the Warden's chain verifier enforces at invocation — issuance-time refusal
 * is a courtesy; the verifier is the only enforcement point (per `attenuation.ts`).
 */
export function capabilityNarrows(child: HearthholdCapability, parent: HearthholdCapability): boolean {
  if (child.parentCapability !== parent.id) return false;
  if (!targetWithin(child.invocationTarget, parent.invocationTarget)) return false;
  if (!isSubset(child.authority, parent.authority)) return false;
  return caveatsNarrow(child.caveats, parent.caveats);
}

/**
 * Canonical caveats for the commitment: drop `undefined` optionals and sort discharge caveats
 * deterministically, so the committed blob (attenuation.ts binds it into the salted commitment) and its
 * later disclosure recompute to the same hash regardless of field order. Pure.
 */
export function normalizeCaveats(c: Caveats): Record<string, unknown> {
  const out: Record<string, unknown> = { ceiling: c.ceiling };
  if (c.kinds && c.kinds.length > 0) out.kinds = [...c.kinds].sort();
  if (c.owner !== undefined) out.owner = c.owner;
  if (c.audience !== undefined) out.audience = c.audience;
  if (c.expires !== undefined) out.expires = c.expires;
  if (c.singleUse !== undefined) out.singleUse = c.singleUse;
  if (c.requiresDischarge && c.requiresDischarge.length > 0) {
    out.requiresDischarge = [...c.requiresDischarge]
      .map((d) => ({ by: d.by, predicate: d.predicate, ...(d.location !== undefined ? { location: d.location } : {}) }))
      .sort((a, b) => `${a.by}::${a.predicate}`.localeCompare(`${b.by}::${b.predicate}`));
  }
  if (c.status !== undefined) {
    out.status = { statusListCredential: c.status.statusListCredential, statusListIndex: c.status.statusListIndex };
  }
  return out;
}
