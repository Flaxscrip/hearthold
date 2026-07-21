/**
 * Rulesets — the Sovereign-signed, versioned, append-only operating law for a governed actor.
 *
 * A Ruleset names what an actor (a Emissary, a cantrip, a composition, the KB, …) may do — which kinds,
 * which verbs, up to what sensitivity ceiling, and (converging the KB assurance policy) at what
 * assurance per verb. It takes effect only when signed by the Sovereign (`keymaster.addProof` — the
 * same detached-signature path as evidence approvals), and every version links to its predecessor,
 * giving an auditable chain of *which rules were in force when*. The Warden refuses to enforce an
 * unsigned or unchained Ruleset.
 *
 * This generalizes Hearthold's "Sovereign-signed policy" roadmap item and subsumes the (unsigned) KB
 * assurance-policy asset with something signed + verifiable + audited. Pure/transport-free.
 */

import { createHash } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import type { AssuranceTier } from './trust-registry.js';

/** Lifecycle of the chain's head. Non-head versions are 'superseded' by position (a display state). */
export type RulesetStatus = 'active' | 'superseded' | 'revoked';

export interface RulesetCapabilities {
  /** Artefact kinds this actor may touch (empty/absent = none). */
  kinds?: string[];
  /** Verbs the actor may perform: 'read' | 'query' | 'propose' | 'send' | 'write' | … */
  verbs?: string[];
  /** Required assurance per verb — converges the KB assurance policy (e.g. `{ write: 'factor2' }`). */
  assurance?: Partial<Record<string, AssuranceTier>>;
  /**
   * Audiences (counterparty ids) for which this actor may bind an external grant / DTG VRC to a
   * STABLE, non-pairwise identity. External identities are pairwise-by-default (DTG v0.3's
   * R-DID-per-relationship MUST and CGPR's deliberate-choice rule); a stable identifier is a
   * conspicuous, signed, versioned exception — never a silent opt-out. Empty/absent = every external
   * identity must be pairwise. Enforced at the mint chokepoint by `enforcePairwiseSubject`.
   */
  stableDidAudiences?: string[];
  /**
   * The Sovereign's KEY-CUSTODY policy for pairwise R-DIDs: for which relationships does the Sovereign
   * hold the key itself (`'subject'` — the Signet proves control directly, for identity anchors a
   * counterparty KYCs) vs. let the Warden hold it (`'warden'` — the custodian presents on the
   * Sovereign's behalf, for plain disclosure). It is the SOVEREIGN's own choice, named per audience and
   * SIGNED — never a built-in category. Absent ⇒ `default: 'warden'`. Enforced at the mint chokepoint by
   * `enforceKeyCustody`; resolve an audience with `resolveKeyHolder`.
   */
  keyCustody?: {
    /** Key holder for any audience not explicitly listed below. Absent ⇒ `'warden'`. */
    default?: 'warden' | 'subject';
    /** Audiences the Sovereign keys itself (Signet-held R-DID; the Sovereign proves control). */
    subject?: string[];
    /** Audiences the Warden keys (overrides a `'subject'` default for these). */
    warden?: string[];
  };
}

export interface Ruleset {
  /** The governed actor — a DID (Emissary/cantrip/composition) or a stable id. */
  actor: string;
  /** 'emissary' | 'cantrip' | 'composition' | 'theme' | 'kb' | … */
  actorKind: string;
  /** Optional resource scope (e.g. a KB id). */
  resource?: string;
  /** 1-based, contiguous version. */
  version: number;
  /** Content id (`rulesetId`) of the prior signed version, or null for the genesis. */
  previous: string | null;
  capabilities: RulesetCapabilities;
  /** Max Sensitivity this actor may reach. */
  ceiling: number;
  status: RulesetStatus;
  /**
   * Guardianship (guardianship-threat-model.md §3): the household MEMBER whose PRIVATE scope this version
   * grants `actor` (a governor) access into. Its presence marks the version access-widening — such a
   * transition is invalid unless this member's own acknowledgment signature (`memberAck`) is in it.
   * "Guardianship is grantable but never seizable."
   */
  subject?: string;
  /** Guardianship expiry (ISO): a guardian read past this is refused. Emancipation = a signed supersession. */
  validUntil?: string;
}

/**
 * A Ruleset plus the governor's detached signature (`proof`). A guardianship version ALSO carries the
 * `subject` member's acknowledgment signature (`memberAck`) — both are over the same base ruleset, so
 * neither invalidates the other.
 */
export type SignedRuleset = Ruleset & { proof?: unknown; memberAck?: unknown };

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const short = (did: string): string => (did.length > 24 ? `${did.slice(0, 24)}…` : did);

/** Deterministic JSON with recursively sorted keys — so a content id is stable across re-serialization. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Stable content id of a signed Ruleset version — used as the next version's `previous` link. */
export function rulesetId(signed: SignedRuleset): string {
  return sha256hex(stableStringify(signed));
}

/** The Sovereign signs a Ruleset version with their own key. */
export async function signRuleset(sovereign: KeymasterHandle, ruleset: Ruleset): Promise<SignedRuleset> {
  return (await sovereign.keymaster.addProof(ruleset)) as SignedRuleset;
}

/**
 * A source of Ruleset signatures — the governance seam. `governor` is the DID the resulting chain will
 * be signed by (readers pin it); `sign` returns the signed version, or null if governance declined
 * (e.g. the Signet denied). Two implementations: `selfSigner` (the Warden self-governs — default /
 * tests) and a DIDComm signer that routes to a governing Sovereign's Signet (see `warden/kb.ts`).
 */
export interface RulesetSigner {
  readonly governor: string;
  sign(ruleset: Ruleset, summary: string): Promise<SignedRuleset | null>;
}

/** Self-signing signer: `handle` signs its own policy (self-governed). Governor = `handle`'s DID. */
export function selfSigner(handle: KeymasterHandle, governor: string): RulesetSigner {
  return { governor, sign: (ruleset) => signRuleset(handle, ruleset) };
}

export interface RulesetCheck {
  ok: boolean;
  reason: string;
  signer?: string;
}

/** The base ruleset — the body both the governor and the member sign, with no signatures attached. */
function baseRuleset(signed: SignedRuleset): Ruleset {
  const { proof: _p, memberAck: _m, ...base } = signed;
  return base as Ruleset;
}

/** Verify a single Ruleset version's governor signature (valid + signed by the DID in its proof). */
export async function verifyRuleset(warden: KeymasterHandle, signed: SignedRuleset): Promise<RulesetCheck> {
  if (!signed?.proof) return { ok: false, reason: 'ruleset is not signed' };
  const proof = signed.proof as { verificationMethod?: string };
  const signer = String(proof.verificationMethod ?? '').split('#')[0] ?? '';
  if (!signer) return { ok: false, reason: 'no signer in proof' };
  // Verify the governor proof over the BASE ruleset (exclude the member ack, which is a second signature
  // over the same base — including it would break this verification).
  const toVerify = { ...baseRuleset(signed), proof: signed.proof };
  const verifyProof = warden.keymaster.verifyProof.bind(warden.keymaster) as (o: unknown) => Promise<boolean>;
  if (!(await verifyProof(toVerify).catch(() => false))) return { ok: false, reason: 'signature does not verify' };
  return { ok: true, reason: 'signed', signer };
}

/** The `subject` member co-signs a guardianship version: their acknowledgment over the same base ruleset. */
export async function signMemberAck(member: KeymasterHandle, ruleset: SignedRuleset): Promise<unknown> {
  const signed = (await member.keymaster.addProof(baseRuleset(ruleset))) as { proof?: unknown };
  return signed.proof;
}

/** Verify a guardianship version's member acknowledgment: the `subject` themselves signed this base ruleset. */
async function verifyMemberAck(warden: KeymasterHandle, signed: SignedRuleset): Promise<boolean> {
  if (!signed.memberAck || !signed.subject) return false;
  const toVerify = { ...baseRuleset(signed), proof: signed.memberAck };
  const verifyProof = warden.keymaster.verifyProof.bind(warden.keymaster) as (o: unknown) => Promise<boolean>;
  if (!(await verifyProof(toVerify).catch(() => false))) return false;
  const signer = String((signed.memberAck as { verificationMethod?: string }).verificationMethod ?? '').split('#')[0];
  return signer === signed.subject;
}

/**
 * Does the transition `prev → next` WIDEN a principal's read/authorization reach into another principal's
 * private scope (guardianship-threat-model §3)? True iff `next` grants a governor access into a member's
 * private scope (`subject` set) that the prior version did not already grant at ≥ this reach — a NEW or
 * BROADENED guardianship. Narrowing, re-stating, or non-guardianship changes are not access-widening.
 */
export function widensIntoPrivateScope(prev: Ruleset | undefined, next: Ruleset): boolean {
  if (!next.subject) return false; // not a guardianship grant → governor-domain / self-restricting
  if (!prev || prev.subject !== next.subject) return true; // introduces access into this member's scope
  // Inverted default (Fable review, 2026-07-16): a guardianship version requires the subject's fresh ack
  // UNLESS it is a strict narrowing or a byte-identical restatement of the prior guardianship. Enumerating
  // widening axes proved *under*-inclusive — it missed `validUntil` extension (a ~4-year seizure of the
  // surveillance window), added verbs, and lowered per-verb assurance, each a broadening of the declared
  // scope the member never consented to. "Require ack for anything not provably a narrowing" cannot be
  // under-inclusive by construction; acks are cheap and version-bound, so the member co-signs every
  // expansion of their own watch — the clean statement of *grantable but never seizable*.
  return !guardianshipNarrowsOrEqual(prev, next);
}

/** factor2 > factor1 > (no step-up). Absent required assurance is the weakest — no step-up demanded. */
const assuranceLevel = (t?: AssuranceTier): number => (t === 'factor2' ? 2 : t === 'factor1' ? 1 : 0);

/** Did any verb's required assurance DROP from `prev` to `next` (a step-up weakened = a widening)? */
function assuranceLowered(
  prev: Partial<Record<string, AssuranceTier>> | undefined,
  next: Partial<Record<string, AssuranceTier>> | undefined,
): boolean {
  const verbs = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const v of verbs) if (assuranceLevel(next?.[v]) < assuranceLevel(prev?.[v])) return true;
  return false;
}

/** A guardianship `validUntil` narrows-or-holds iff the window only shrinks. Absent = no expiry (broadest):
 *  a prior with no expiry is never narrowed by adding one is *tightening* (ok); dropping an expiry broadens. */
function validUntilNarrowsOrEqual(prev: string | undefined, next: string | undefined): boolean {
  if (prev === undefined) return true; // prior had no expiry (broadest) — any next window is ≤
  if (next === undefined) return false; // prior expired; next removes the expiry → broadens the window
  return next <= prev; // both set: the window may only shrink (or hold)
}

/**
 * Is `next` a strict narrowing (or byte-identical restatement) of the prior guardianship `prev` over the
 * SAME subject? Every scope axis — ceiling, kinds, verbs, `validUntil`, per-verb assurance — must be
 * equal-or-tighter; any broadening on any single axis makes the transition access-widening (ack required).
 * A `revoked` status is the ultimate narrowing (access → none).
 */
function guardianshipNarrowsOrEqual(prev: Ruleset, next: Ruleset): boolean {
  if (next.status === 'revoked') return true; // ending guardianship narrows to nothing
  if ((next.ceiling ?? 0) > (prev.ceiling ?? 0)) return false; // ceiling raised
  const priorKinds = new Set(prev.capabilities?.kinds ?? []);
  if ((next.capabilities?.kinds ?? []).some((k) => !priorKinds.has(k))) return false; // kind added
  const priorVerbs = new Set(prev.capabilities?.verbs ?? []);
  if ((next.capabilities?.verbs ?? []).some((v) => !priorVerbs.has(v))) return false; // verb added
  if (!validUntilNarrowsOrEqual(prev.validUntil, next.validUntil)) return false; // window extended
  if (assuranceLowered(prev.capabilities?.assurance, next.capabilities?.assurance)) return false; // step-up weakened
  return true;
}

/**
 * Verify an actor's whole Ruleset chain: version-ordered and contiguous from 1, each version signed by
 * the SAME Sovereign, `previous` links intact, and the actor stable across the chain. The head (highest
 * version) is the operative Ruleset; its status says whether the actor is `active` or `revoked`. The
 * Warden must refuse to enforce a chain that fails this.
 */
export async function verifyRulesetChain(
  warden: KeymasterHandle,
  chain: SignedRuleset[],
  opts: { expectedSigner?: string } = {},
): Promise<RulesetCheck> {
  if (chain.length === 0) return { ok: false, reason: 'empty chain' };
  const ordered = [...chain].sort((a, b) => a.version - b.version);
  const head = ordered[ordered.length - 1] as SignedRuleset;
  let signer: string | undefined;

  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i] as SignedRuleset;
    const check = await verifyRuleset(warden, r);
    if (!check.ok) return { ok: false, reason: `v${r.version}: ${check.reason}` };
    if (i === 0) signer = check.signer;
    else if (check.signer !== signer) return { ok: false, reason: `v${r.version}: signed by a different DID` };

    if (r.version !== i + 1) return { ok: false, reason: `non-contiguous versions (expected ${i + 1}, got ${r.version})` };
    if (r.actor !== ordered[0]?.actor || r.actorKind !== ordered[0]?.actorKind) {
      return { ok: false, reason: `v${r.version}: actor changed mid-chain` };
    }
    if (i === 0) {
      if (r.previous !== null) return { ok: false, reason: 'genesis must have previous=null' };
    } else if (r.previous !== rulesetId(ordered[i - 1] as SignedRuleset)) {
      return { ok: false, reason: `v${r.version}: broken previous link` };
    }
    // THE AMENDMENT RULE (hoisted into the shared verifier — Fable review 2026-07-16): an access-widening
    // guardianship version without the subject's own acknowledgment is invalid here too, so no consumer
    // that routes a chain through verifyRulesetChain / activeRuleset / authorizeActor can accept a seizure
    // that operativeRuleset would reject. Non-guardianship versions (no `subject`) are unaffected.
    if (widensIntoPrivateScope(ordered[i - 1] as Ruleset | undefined, r) && !(await verifyMemberAck(warden, r))) {
      return { ok: false, reason: `v${r.version}: access-widening guardianship without the subject's acknowledgment` };
    }
  }
  // Governor pinning: the whole point of Signet governance. A reader that expects a specific governing
  // Sovereign rejects any chain not signed by them — so a compromised Warden cannot self-sign policy.
  if (opts.expectedSigner && signer !== opts.expectedSigner) {
    return { ok: false, reason: `chain not signed by the governing DID (${short(opts.expectedSigner)})` };
  }
  return { ok: true, reason: `chain valid (head v${head.version}, ${head.status})`, signer };
}

/**
 * The operative Ruleset under the AMENDMENT RULE (guardianship-threat-model §3) — the household governance
 * verifier. It walks the chain applying signature, contiguity, link, and governor-pin checks AND the
 * amendment rule: a version that **widens a governor's reach into a member's private scope without that
 * member's own acknowledgment signature is invalid, and the operative head falls back to the PRIOR
 * version** (exactly as an unsigned downgrade is rejected today). This is what makes guardianship
 * *grantable but never seizable* — a governor cannot route around consent by editing the constitution,
 * because the verifier rejects the edit and serves the last version the member's key participated in.
 *
 * Returns the operative head (last valid `active` version), or null if even the genesis is invalid.
 */
export async function operativeRuleset(
  warden: KeymasterHandle,
  chain: SignedRuleset[],
  opts: { expectedSigner?: string } = {},
): Promise<SignedRuleset | null> {
  const ordered = [...chain].sort((a, b) => a.version - b.version);
  let lastValid: SignedRuleset | null = null;
  let signer: string | undefined;
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i] as SignedRuleset;
    const check = await verifyRuleset(warden, r);
    if (!check.ok) break; // unsigned/tampered → stop; serve the last valid version
    if (i === 0) signer = check.signer;
    else if (check.signer !== signer) break; // governor changed mid-chain
    if (r.version !== i + 1) break; // non-contiguous
    if (i === 0) {
      if (r.previous !== null) break;
    } else if (r.previous !== rulesetId(ordered[i - 1] as SignedRuleset)) break; // broken link
    // THE AMENDMENT RULE: access-widening into a member's private scope requires that member's ack.
    if (widensIntoPrivateScope(ordered[i - 1] as Ruleset | undefined, r) && !(await verifyMemberAck(warden, r))) {
      break; // seizure attempt → fail closed to the prior version
    }
    lastValid = r;
  }
  if (opts.expectedSigner && signer && signer !== opts.expectedSigner) return null; // governor pinning
  if (!lastValid) return null;
  return lastValid.status === 'active' ? lastValid : null;
}

export interface GuardianReadRequest {
  /** The governor attempting the read (the guardian). */
  governor: string;
  /** The watched member whose data is read. */
  subject: string;
  /** The artefact's kind + sensitivity + the check-time clock. */
  kind?: string;
  sensitivity?: number;
  at: string;
}

/**
 * Authorize a GOVERNOR reading a MEMBER's private data under a Guardianship Ruleset (guardianship-threat-
 * model.md §5). The ladder is not bypassed — it is *satisfied by law*: a guardian read is allowed only
 * within an active, member-acknowledged guardianship edge that names this governor→member, is unexpired,
 * and covers the artefact's kind + sensitivity. Because the chain runs through `operativeRuleset`, a
 * guardianship version the member never acknowledged is invalid and reads are refused (seizure defense);
 * a revoked/emancipated edge has no active head; and a tampered/forged chain fails closed.
 */
export async function authorizeGuardianRead(
  warden: KeymasterHandle,
  chain: SignedRuleset[],
  req: GuardianReadRequest,
): Promise<{ allowed: boolean; reason: string }> {
  const operative = await operativeRuleset(warden, chain, { expectedSigner: req.governor });
  if (!operative) return { allowed: false, reason: 'no active guardianship (unacknowledged, revoked, tampered, or not governor-signed)' };
  if (operative.actor !== req.governor || operative.subject !== req.subject) {
    return { allowed: false, reason: 'the active Ruleset is not a guardianship edge for this governor → member' };
  }
  if (operative.validUntil && req.at > operative.validUntil) {
    return { allowed: false, reason: 'guardianship has expired' };
  }
  const caps = operative.capabilities;
  if (req.kind && caps.kinds && !caps.kinds.includes(req.kind)) {
    return { allowed: false, reason: `kind '${req.kind}' is outside the guardianship scope` };
  }
  if (req.sensitivity !== undefined && req.sensitivity > operative.ceiling) {
    return { allowed: false, reason: `sensitivity ${req.sensitivity} exceeds the guardianship ceiling ${operative.ceiling}` };
  }
  return { allowed: true, reason: 'authorized by the guardianship Ruleset (the ladder is satisfied by law)' };
}

/**
 * The operative Ruleset for an actor: the verified head if it is `active`, else null (a revoked head or
 * an invalid chain governs nothing — fail closed).
 */
export async function activeRuleset(
  warden: KeymasterHandle,
  chain: SignedRuleset[],
  opts: { expectedSigner?: string } = {},
): Promise<SignedRuleset | null> {
  const check = await verifyRulesetChain(warden, chain, opts);
  if (!check.ok) return null;
  const head = [...chain].sort((a, b) => a.version - b.version).pop() as SignedRuleset;
  return head.status === 'active' ? head : null;
}

/** A single thing a contained actor (a cantrip, a composition, …) wants to do. */
export interface ActorRequest {
  /** 'read' | 'query' | 'propose' | 'send' | 'write' | … */
  verb: string;
  /** The artefact kind touched, if any. */
  kind?: string;
  /** The sensitivity the request would reach — checked against the actor's ceiling. */
  sensitivity?: number;
}

export interface ActorAuthz {
  allowed: boolean;
  reason: string;
  /** The assurance the verb requires, if the Ruleset declares one (step-up, as with the KB). */
  requiredAssurance?: AssuranceTier;
}

/**
 * Authorize a contained actor's request against its active Ruleset — the generalized inward-registry
 * check: the same primitive that grades a Emissary's autonomy now bounds a cantrip (or any actor). The
 * interpreter sandbox contains *computation*; **this is where the Warden contains disclosure**. Fail
 * closed: no active Ruleset (unsigned / revoked / tampered / missing) authorizes nothing.
 */
export async function authorizeActor(
  warden: KeymasterHandle,
  chain: SignedRuleset[],
  req: ActorRequest,
  opts: { expectedSigner?: string } = {},
): Promise<ActorAuthz> {
  const head = await activeRuleset(warden, chain, opts);
  if (!head) return { allowed: false, reason: 'no active Ruleset for this actor (unsigned, revoked, tampered, or not governed by the expected Sovereign)' };
  const caps = head.capabilities;
  if (caps.verbs && !caps.verbs.includes(req.verb)) {
    return { allowed: false, reason: `verb '${req.verb}' is not in the actor's Ruleset` };
  }
  if (req.kind && caps.kinds && !caps.kinds.includes(req.kind)) {
    return { allowed: false, reason: `kind '${req.kind}' is not in the actor's Ruleset` };
  }
  if (req.sensitivity !== undefined && req.sensitivity > head.ceiling) {
    return { allowed: false, reason: `sensitivity ${req.sensitivity} exceeds the actor's ceiling ${head.ceiling}` };
  }
  return { allowed: true, reason: "within the actor's active Ruleset", requiredAssurance: caps.assurance?.[req.verb] };
}
