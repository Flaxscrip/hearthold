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
}

/** A Ruleset plus the Sovereign's detached signature. */
export type SignedRuleset = Ruleset & { proof?: unknown };

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

/** Verify a single Ruleset version's signature (valid + signed by the DID in its proof). */
export async function verifyRuleset(warden: KeymasterHandle, signed: SignedRuleset): Promise<RulesetCheck> {
  if (!signed?.proof) return { ok: false, reason: 'ruleset is not signed' };
  const proof = signed.proof as { verificationMethod?: string };
  const signer = String(proof.verificationMethod ?? '').split('#')[0] ?? '';
  if (!signer) return { ok: false, reason: 'no signer in proof' };
  const verifyProof = warden.keymaster.verifyProof.bind(warden.keymaster) as (o: unknown) => Promise<boolean>;
  if (!(await verifyProof(signed).catch(() => false))) return { ok: false, reason: 'signature does not verify' };
  return { ok: true, reason: 'signed', signer };
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
  }
  // Governor pinning: the whole point of Signet governance. A reader that expects a specific governing
  // Sovereign rejects any chain not signed by them — so a compromised Warden cannot self-sign policy.
  if (opts.expectedSigner && signer !== opts.expectedSigner) {
    return { ok: false, reason: `chain not signed by the governing DID (${short(opts.expectedSigner)})` };
  }
  return { ok: true, reason: `chain valid (head v${head.version}, ${head.status})`, signer };
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
