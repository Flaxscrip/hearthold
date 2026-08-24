/**
 * Trusted-Knowledge Mesh — v1 (the one-hop, trust-gated query).
 *
 * A constrained slice of the mesh: a query travels from node A's Emissary to a recognized friend node B's
 * Warden and returns a SIGNED, PAIRWISE-ENCRYPTED evidence graph. It proves the core loop end-to-end; the
 * full network (multi-hop, querier privacy, recognition-graph privacy, unlinkability) is deferred — see
 * FINDINGS.md.
 *
 * Architecture invariant (non-negotiable): the Warden is home-bound and NEVER faces a foreign node — only
 * the Emissary crosses. B's Warden runs `MeshWarden` as a backend handed a neutral request by B's edge
 * (its Emissary, the production relay — modeled in-process here, exactly as CgprService sits behind the
 * A2A gateway). Archon stays dumb: it signs opaque blobs (`addProof`) and stores encrypted content
 * (`encryptJSON`). All mesh semantics live here.
 *
 * Reuse, not reinvention — the two scopings ARE the prior models applied to new payloads:
 *   - the QUERY BUDGET is an attenuation delegation (A's Warden → A's Emissary): the Emissary
 *     structurally cannot exceed its delegated scope (`isSubset`, from attenuation.ts).
 *   - the RECOGNITION credential is a selective-disclosure VC (B's Sovereign → A's Emissary): A reveals to
 *     B only the properties B's admission policy needs (from selective-disclosure.ts).
 */

import { randomUUID } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import type { HearthholdConfig } from './config.js';
import { isSubset, type AuthoritySet } from './attenuation.js';
import {
  issueDisclosureCredential,
  assemblePresentation,
  verifyPresentation,
  type IssuedDisclosureCredential,
  type Presentation,
} from './selective-disclosure.js';
import { STATUS_LIST_LENGTH } from './status-list.js';
import type { StatusListResolver, StatusListPin } from './status-list.js';
import { allocateIndex } from './allocation.js';

// ── Recognition (B's Sovereign recognizes A's Emissary) ────────────────────────────────────────────────

/** The scoped recognition B's Sovereign grants A. Issued as a selective-disclosure VC; revocable. */
export interface RecognitionScope {
  /** The DID being recognized (A's Emissary — the admission token's holder/presenter). */
  subject: string;
  tier: string;
  confidence: number;
  domain: string;
  mode: 'fact' | 'reasoning';
  maxDepth: number;
}

/**
 * B's Sovereign issues a recognition credential naming A's Emissary, scoped. Revocation rides a W3C
 * Bitstring Status List: a RANDOM `statusListIndex` (never sequential — that would leak issuance order) into
 * the issuer's `statusListCredential`; a set bit means revoked. `recognitionId` remains as an opaque identity
 * label (used in relay assertions) but is NOT the revocation key and never enters the published list.
 *
 * The index is allocated durably + collision-free through the issuer's sealed AllocationRecord (allocation.ts).
 */
export async function issueRecognition(args: {
  issuer: KeymasterHandle;
  issuerName: string;
  subject: string;
  scope: Omit<RecognitionScope, 'subject'>;
  /** The issuer's StatusList asset DID — recorded in the credential so a checker resolves the right list. */
  statusListCredential: string;
  /** The issuer's sealed AllocationRecord DID — where the durable recognitionId → index mapping lives. */
  allocationRecord: string;
  registry: string;
}): Promise<IssuedDisclosureCredential & { recognitionId: string; statusListIndex: number; statusListCredential: string }> {
  const recognitionId = randomUUID();
  const { index: statusListIndex } = await allocateIndex(args.issuer, args.issuerName, args.allocationRecord, recognitionId, STATUS_LIST_LENGTH);
  const cred = await issueDisclosureCredential({
    issuer: args.issuer,
    issuerName: args.issuerName,
    holder: args.subject,
    properties: {
      subject: args.subject,
      tier: args.scope.tier,
      confidence: args.scope.confidence,
      domain: args.scope.domain,
      mode: args.scope.mode,
      maxDepth: args.scope.maxDepth,
      recognitionId,
      statusListIndex,
      statusListCredential: args.statusListCredential,
    },
    credentialType: 'MeshRecognition',
    registry: args.registry,
  });
  return { ...cred, recognitionId, statusListIndex, statusListCredential: args.statusListCredential };
}

/**
 * What an admission policy needs to see. A discloses these; domain/mode stay hidden. `maxDepth` is disclosed
 * (FIX-FIRST — depth authority): each hop enforces how far the RECOGNITION authorized propagation, not only
 * its own partition policy. `statusListIndex` + `statusListCredential` are disclosed so the checker can read
 * the revocation bit; `recognitionId` for identity/audit.
 */
export const RECOGNITION_DISCLOSE = ['subject', 'tier', 'recognitionId', 'confidence', 'maxDepth', 'statusListIndex', 'statusListCredential'] as const;

/** A's Emissary assembles the recognition presentation, revealing only what B admits on. */
export function presentRecognition(cred: IssuedDisclosureCredential): Presentation {
  return assemblePresentation(cred.commitments, cred.disclosures, [...RECOGNITION_DISCLOSE]);
}

// ── Query budget (A's Warden delegates to A's Emissary — attenuation) ───────────────────────────────────

export interface QueryBudget {
  maxNodes: number;
  rate: number;
}

export interface MeshQuery {
  text: string;
  mode: 'fact' | 'reasoning';
  domain: string;
  budget: QueryBudget;
  /**
   * Arrival depth — how many hops the query travelled from the origin to reach the current node (1 at the
   * first hop; INCREMENTED on each forward). One of the two partition-ladder axes. Absent ⇒ 1. Set by the
   * sender, honoured by the recognizing receiver — the same trust model as `depthRemaining`.
   */
  arrivalDepth?: number;
  /**
   * Composed path confidence so far (product of the edge confidences up to the presenter). Threaded by
   * relays so the answering node can gate on the whole path, not just its local edge. Absent ⇒ 1.
   */
  pathConfidence?: number;
  /**
   * Propagation budget (depth-2): forwards still allowed. A recognition of `maxDepth k` authorizes `k-1`
   * forwards from where it is presented. Set by the origin from its recognition; strictly decremented on
   * each forward. `< 1` ⇒ this node cannot forward. Absent ⇒ 0 (answer-only).
   */
  depthRemaining?: number;
  /** Warden DIDs already on the path — the cycle guard rejects forwarding to any node already here. */
  visited?: string[];
}

/**
 * The delegated scope as an attenuation `AuthoritySet`: the verb `query` over `domain:*` / `mode:*` tokens.
 * A query the Emissary forms MUST be a subset of this (categorical scope) — reused straight from attenuation.
 * (The numeric budget below is a `≤` check, the natural numeric analogue of set-⊆; see FINDINGS.)
 */
export function delegatedScope(domains: string[], modes: Array<'fact' | 'reasoning'>): AuthoritySet {
  return { operations: ['query'], resources: [...domains.map((d) => `domain:${d}`), ...modes.map((m) => `mode:${m}`)] };
}

/**
 * A-side structural gate: the Emissary's query must not exceed its delegation. Categorical scope is an
 * attenuation `isSubset`; the numeric budget is `≤`. Fails A-SIDE (before B ever sees it) — the Emissary
 * cannot form an over-budget query, which is the whole point of delegating it as an attenuation credential.
 */
export function scopeQueryToDelegation(
  query: MeshQuery,
  delegated: AuthoritySet,
  delegatedBudget: QueryBudget,
): { ok: boolean; reason?: string } {
  const requested: AuthoritySet = { operations: ['query'], resources: [`domain:${query.domain}`, `mode:${query.mode}`] };
  if (!isSubset(requested, delegated)) {
    return { ok: false, reason: `query {${query.mode} on ${query.domain}} exceeds the delegated attenuation scope` };
  }
  if (query.budget.maxNodes > delegatedBudget.maxNodes) {
    return { ok: false, reason: `maxNodes ${query.budget.maxNodes} exceeds delegated ${delegatedBudget.maxNodes}` };
  }
  if (query.budget.rate > delegatedBudget.rate) {
    return { ok: false, reason: `rate ${query.budget.rate} exceeds delegated ${delegatedBudget.rate}` };
  }
  return { ok: true };
}

// ── The hop + the answer ───────────────────────────────────────────────────────────────────────────────

/** What A's Emissary sends across (relayed to B's Warden by B's edge). */
export interface MeshQueryEnvelope {
  query: MeshQuery;
  recognition: Presentation;
  /** A's Emissary DID — B binds the recognition to it and encrypts the answer to it. */
  presenterDid: string;
}

/** A node's admission policy. Tier ordering + revocation are policy; the partition ladder is passed separately. */
export interface MeshPolicy {
  /** The Sovereign whose recognitions this node honors (its own). */
  recognizedIssuer: string;
  /**
   * EXPLICIT tier ranking, lowest → highest (e.g. `['world','acquaintance','close-friend']`). Rank is the
   * index; a tier not in this list has NO rank and reaches nothing (deny by default). Never compare tier
   * name strings — that is a bug waiting to happen; rank through this list.
   */
  tierOrder: string[];
  /**
   * Durable revocation — REQUIRED: a resolver over the issuer's published Bitstring StatusList asset
   * (fail-closed, version-pinned). No in-memory fallback; durability is not opt-in. For a node with no
   * revocations, point it at a freshly-created (empty) StatusList. See status-list.ts.
   */
  statusList: StatusListResolver;
  /**
   * How many forwards this node is willing to RELAY (the propagation axis — distinct from partition
   * arrival-depth gating). Effective reach = `min(recognition.maxDepth - 1, maxRelayDepth)`. Absent ⇒ 0.
   */
  maxRelayDepth?: number;
}

/** One fact in a partition, with its provenance. */
export interface PartitionFact {
  ref: string;
  provenance: 'asserted' | 'inferred';
  confidence: number;
  narrative: string;
  keywords: string[];
}

/**
 * A partition's access policy — TWO INDEPENDENT axes, both of which must hold (ANDed). Never collapse them
 * into one score: "reached me through trusted hops" (depth) must not silently become "I trust them" (tier).
 */
export interface PartitionAccess {
  /** Minimum recognition tier (a name in the policy's `tierOrder`) the presenter must hold. */
  minTier: string;
  /** Maximum arrival depth: the query must have reached this node in ≤ this many hops. */
  maxArrivalDepth: number;
  /** Optional: minimum composed path confidence. */
  minPathConfidence?: number;
}

/** One rung of the ladder: a named, domain-scoped, access-gated set of facts. */
export interface Partition {
  name: string;
  domain: string;
  facts: PartitionFact[];
  access: PartitionAccess;
}

/** An ordered ladder of gated partitions (e.g. world-public → acquaintance → close-friend). */
export type PartitionLadder = Partition[];

/** The signed, returned evidence graph. `proof` is B's Warden's signature over everything above it. */
export interface MeshAnswer {
  reference: string;
  /** "Sovereign B personally asserts" vs "B's AI inferred from B's notes" — signed, unforgeable by A. */
  provenance: 'asserted' | 'inferred';
  factConfidence: number;
  /** The recognition-path confidence carried from the recognition credential. */
  recognitionConfidence: number;
  narrative: string;
  domain: string;
  answeredBy: string;
  answeredAt: string;
  /** Audit binding: when the status was checked, and the exact pinned StatusList version it was checked against. */
  statusCheckedAt?: string;
  statusListVersion?: StatusListPin;
  proof?: { verificationMethod: string; proofValue: string; created: string; [k: string]: unknown };
}

export type MeshResult =
  | { status: 'granted'; answerDid: string }
  | { status: 'rejected'; reason: string; check: string }
  /** No local answer and no valid forward — a CLEAN miss, never a fabricated answer (BROKEN-RELAY). */
  | { status: 'no-answer'; reason: string };

/**
 * The set of ladder rungs a presenter may read from, given (tier, arrivalDepth, pathConfidence). DENY BY
 * DEFAULT: a rung is included only if BOTH axes hold (tier rank ≥ minTier rank AND arrivalDepth ≤
 * maxArrivalDepth), plus the optional confidence floor. The axes are ANDed and never merged into one score.
 */
export function permittedPartitions(
  ladder: PartitionLadder,
  tierOrder: string[],
  presenterTier: string,
  arrivalDepth: number,
  pathConfidence: number,
): Partition[] {
  const presenterRank = tierOrder.indexOf(presenterTier);
  if (presenterRank < 0) return []; // an unranked tier reaches nothing
  return ladder.filter((p) => {
    const needRank = tierOrder.indexOf(p.access.minTier);
    if (needRank < 0) return false; // a rung requiring an unknown tier is unreachable
    if (presenterRank < needRank) return false; // TIER axis
    if (arrivalDepth > p.access.maxArrivalDepth) return false; // DEPTH axis (independent — both must hold)
    if (p.access.minPathConfidence != null && pathConfidence < p.access.minPathConfidence) return false;
    return true;
  });
}

/**
 * Reason ONLY over the permitted rungs (SANDBOXED — a fact in a gated rung is unreachable, not merely
 * unranked). A keyword lookup here; an LLM call restricted to these partitions would slot in identically.
 * Returns the matching fact + its source rung, or null. The caller must give the SAME response for a null
 * here whether a gated rung secretly matched or nothing matched at all (INDISTINGUISHABILITY).
 */
export function reasonOverPartitions(query: MeshQuery, permitted: Partition[]): { fact: PartitionFact; partition: string } | null {
  const q = query.text.toLowerCase();
  for (const p of permitted) {
    if (p.domain !== query.domain) continue;
    const hit = p.facts.find((f) => f.keywords.some((k) => q.includes(k)));
    if (hit) return { fact: hit, partition: p.name };
  }
  return null;
}

/**
 * Per-hop budget attenuation (depth-2): a forwarded query must be a CHILD of the incoming one — categorical
 * scope `isSubset` AND numeric budget `≤`. Same attenuation model as the A-side delegation gate, applied at
 * B before forwarding. Reused, not reinvented.
 */
export function budgetSubset(child: MeshQuery, parent: MeshQuery): { ok: boolean; reason?: string } {
  const scope = (q: MeshQuery): AuthoritySet => ({ operations: ['query'], resources: [`domain:${q.domain}`, `mode:${q.mode}`] });
  if (!isSubset(scope(child), scope(parent))) return { ok: false, reason: `forward {${child.mode} on ${child.domain}} is not a subset of the incoming grant` };
  if (child.budget.maxNodes > parent.budget.maxNodes) return { ok: false, reason: `forward maxNodes ${child.budget.maxNodes} exceeds incoming ${parent.budget.maxNodes}` };
  if (child.budget.rate > parent.budget.rate) return { ok: false, reason: `forward rate ${child.budget.rate} exceeds incoming ${parent.budget.rate}` };
  if ((child.depthRemaining ?? 0) > (parent.depthRemaining ?? 0) - 1) return { ok: false, reason: 'forward depthRemaining did not strictly decrease' };
  return { ok: true };
}

/** A recognition THIS node holds of a friend (the friend recognized this node): presented when forwarding. */
export interface FriendRecognition {
  /** The credential the friend issued naming this node's Emissary (friend recognizes me). */
  cred: IssuedDisclosureCredential;
  recognitionId: string;
  /** The friend edge's recognition confidence (composed into the path confidence). */
  confidence: number;
  /** The friend's answering Warden DID — the forward target; used for the cycle guard + verification. */
  friendWardenDid: string;
  domain: string;
}

/**
 * A node's forwarding capability. Its EMISSARY is the crossing agent; `reachFriend` is that Emissary
 * crossing to a friend's Warden and returning its result — the Warden itself never holds a foreign handle.
 * In-process the harness wires `reachFriend` to the friend's `MeshWarden.handle`; the invariant is
 * structural (this Warden only ever receives a neutral result back).
 */
export interface MeshForwarding {
  emissary: KeymasterHandle;
  emissaryName: string;
  emissaryDid: string;
  friends: FriendRecognition[];
  reachFriend: (friendWardenDid: string, envelope: MeshQueryEnvelope) => Promise<MeshResult>;
}

/** B's signed assertion that it relayed C's answer under C's recognition of B — the trust-basis for the B→C edge. */
export interface RelayAssertion {
  relayedBy: string;
  answerer: string;
  /** The C→B edge confidence (C recognizes B). */
  edgeConfidence: number;
  recognitionId: string;
  forwardedAt: string;
  proof?: { verificationMethod: string; proofValue: string; created: string; [k: string]: unknown };
}

/** The two-signature return: C's signed answer + B's signed relay assertion. A assembles the path from these. */
export interface ForwardedAnswer {
  answer: MeshAnswer;
  relay: RelayAssertion;
}

/**
 * B's Warden mesh backend. Never faces a foreign node: it is handed a neutral `MeshQueryEnvelope` by B's
 * edge, admits it (recognition valid + names the presenter + not revoked + forwarding authority), then
 * reasons SANDBOXED over the partition rungs the presenter's (tier, arrivalDepth) permit, and returns a
 * signed answer pairwise-encrypted to A's Emissary. Deny by default; gated rungs are unreachable.
 */
export class MeshWarden {
  constructor(
    private readonly warden: KeymasterHandle,
    private readonly wardenName: string,
    private readonly config: HearthholdConfig,
    private readonly policy: MeshPolicy,
    /** The ordered ladder of gated partitions this node hosts (world-public → … → close-friend). */
    private readonly ladder: PartitionLadder,
    /** Depth-2: the forwarding capability (this node's Emissary + friend recognitions). Omit ⇒ answer-only. */
    private readonly forwarding?: MeshForwarding,
  ) {}

  /** Admission — deny-by-default. Returns the disclosed recognition fields (+ any status pin) on ACCEPT. */
  async admit(envelope: MeshQueryEnvelope): Promise<{ ok: boolean; reason?: string; check?: string; disclosed?: Record<string, unknown>; statusPin?: StatusListPin }> {
    // 1. The recognition must verify AND be issued by the Sovereign B recognizes (its own).
    const v = await verifyPresentation(envelope.recognition, { keymaster: this.warden, expectedIssuer: this.policy.recognizedIssuer });
    if (!v.ok) return { ok: false, reason: `recognition not honored: ${v.reason}`, check: v.check === 'issuer' ? 'recognition' : v.check ?? 'recognition' };
    const d = v.disclosed ?? {};

    // 2. It must name the presenter (the admission token is bound to A's Emissary).
    if (d.subject !== envelope.presenterDid) return { ok: false, reason: 'recognition does not name the presenting Emissary', check: 'binding' };

    // (Tier + arrival-depth are NOT admission gates — they select which partition RUNGS the presenter may
    //  read, deny-by-default, in handle(). Admission verifies the recognition; the ladder gates the answer.)

    // 4. Revocation — read the recognition's bit in the durable Bitstring StatusList, FAIL-CLOSED if the
    //    fact is unavailable. The recognition must point at the list this node checks. Carry the pin so the
    //    answer can bind the exact list version checked (after-the-fact dispute).
    if (typeof d.statusListCredential === 'string' && d.statusListCredential !== this.policy.statusList.statusListCredential) {
      return { ok: false, reason: 'recognition points at a different status list than this node checks', check: 'revocation' };
    }
    const statusListIndex = Number(d.statusListIndex);
    const rc = await this.policy.statusList.check(statusListIndex);
    if (!rc.available) return { ok: false, reason: `revocation status unavailable — deny (fail-closed): ${rc.reason}`, check: 'revocation' };
    if (rc.revoked) return { ok: false, reason: 'recognition has been revoked (status bit set)', check: 'revocation' };
    const statusPin = rc.pin;

    // 6. Depth authority (FIX-FIRST): the query's remaining forward budget must not exceed what the
    //    RECOGNITION authorized (maxDepth-1 forwards) NOR what this partition permits (maxRelayDepth) —
    //    min of the two. Catches an over-claim (e.g. a maxDepth-1 recognition used to reach depth 2).
    const authorizedForwards = Number(d.maxDepth ?? 1) - 1;
    const permittedForwards = Math.min(authorizedForwards, this.policy.maxRelayDepth ?? 0);
    const claimedRemaining = envelope.query.depthRemaining ?? 0;
    if (claimedRemaining > permittedForwards) {
      return {
        ok: false,
        reason:
          `depthRemaining ${claimedRemaining} exceeds the permitted ${permittedForwards} ` +
          `(recognition authorizes ${authorizedForwards} forward(s), partition permits ${this.policy.maxRelayDepth ?? 0})`,
        check: 'depth',
      };
    }
    return { ok: true, disclosed: d, statusPin };
  }

  async handle(envelope: MeshQueryEnvelope): Promise<MeshResult> {
    const adm = await this.admit(envelope);
    if (!adm.ok) return { status: 'rejected', reason: adm.reason ?? 'admission denied', check: adm.check ?? 'admission' };
    const d = adm.disclosed ?? {};

    // Two-axis gating (deny by default): which rungs does (tier, arrivalDepth, composed path confidence)
    // permit? The composed confidence is this path's product so far × the presenter's local edge.
    const arrivalDepth = envelope.query.arrivalDepth ?? 1;
    const pathConfidence = (envelope.query.pathConfidence ?? 1) * Number(d.confidence ?? 0);
    const permitted = permittedPartitions(this.ladder, this.policy.tierOrder, String(d.tier ?? ''), arrivalDepth, pathConfidence);

    // 1. Reason SANDBOXED over the permitted rungs only — a gated rung is unreachable, not merely unranked.
    const hit = reasonOverPartitions(envelope.query, permitted);
    if (hit) {
      const fact = hit.fact;
      const km = this.warden.keymaster;
      await km.setCurrentId(this.wardenName);
      const answeredBy = (await km.resolveDID(this.wardenName)).didDocument?.id ?? '';
      const body: MeshAnswer = {
        reference: fact.ref,
        provenance: fact.provenance,
        factConfidence: fact.confidence,
        recognitionConfidence: Number(d.confidence ?? 0),
        narrative: fact.narrative,
        domain: envelope.query.domain,
        answeredBy,
        answeredAt: new Date().toISOString(),
        // Bind the status check into the signed answer (audit): which StatusList version proved not-revoked.
        statusCheckedAt: adm.statusPin ? new Date().toISOString() : undefined,
        statusListVersion: adm.statusPin,
      };
      const signed = (await km.addProof(body, this.wardenName)) as MeshAnswer; // this Warden signs the graph
      const answerDid = await km.encryptJSON(signed, envelope.presenterDid, { registry: this.config.registry }); // pairwise to the presenter
      return { status: 'granted', answerDid };
    }

    // 2. No PERMITTED answer. INDISTINGUISHABILITY: this response is identical whether a gated rung secretly
    //    matched or nothing matched at all — the reasoning above literally cannot see gated rungs, so "no
    //    answer" is never an oracle for what exists in partitions the presenter can't reach. Forward if we
    //    can (unchanged by any gated match); otherwise a CONSTANT no-answer.
    if (this.forwarding) return this.forward(envelope, pathConfidence);
    return { status: 'no-answer', reason: 'no answer available' };
  }

  /** Depth-2 relay: this node's Emissary crosses to a recognized friend, then this Warden re-packages. */
  private async forward(incoming: MeshQueryEnvelope, pathConfidence: number): Promise<MeshResult> {
    const f = this.forwarding!;
    const remaining = incoming.query.depthRemaining ?? 0;
    // Propagation depth exhausted: a hard stop on forwarding (DEPTH-STOP), distinct from a clean no-answer.
    if (remaining < 1) return { status: 'rejected', reason: `propagation depth exhausted (depthRemaining ${remaining}) — cannot forward further`, check: 'depth' };

    // No recognized friend for this domain: a CLEAN no-answer (BROKEN-RELAY), never a fabricated answer.
    const friend = f.friends.find((fr) => fr.domain === incoming.query.domain);
    if (!friend) return { status: 'no-answer', reason: 'no recognized friend covers this domain — clean no-answer' };

    const visited = incoming.query.visited ?? [];
    const km = this.warden.keymaster;
    await km.setCurrentId(this.wardenName);
    const myDid = (await km.resolveDID(this.wardenName)).didDocument?.id ?? '';
    if (visited.includes(friend.friendWardenDid)) {
      return { status: 'rejected', reason: `cycle: ${friend.friendWardenDid.slice(0, 24)}… is already on the path`, check: 'cycle' };
    }

    // Attenuate the query for the forward: strictly decrement depthRemaining; INCREMENT arrivalDepth (the
    // friend is one hop deeper from the origin); thread the composed pathConfidence so far. Scope/budget ⊆.
    const forwardQuery: MeshQuery = {
      ...incoming.query,
      arrivalDepth: (incoming.query.arrivalDepth ?? 1) + 1,
      pathConfidence,
      depthRemaining: remaining - 1,
      visited: [...visited, myDid],
    };
    const chk = budgetSubset(forwardQuery, incoming.query);
    if (!chk.ok) return { status: 'rejected', reason: `budget attenuation: ${chk.reason}`, check: 'budget' };

    // B's EMISSARY crosses to C, presenting B's (friend's) recognition. presenterDid = B's Emissary — NOT
    // A's — so C never learns the querier A (querier-privacy boundary; documented in FINDINGS).
    const fwdEnvelope: MeshQueryEnvelope = { query: forwardQuery, recognition: presentRecognition(friend.cred), presenterDid: f.emissaryDid };
    const cResult = await f.reachFriend(friend.friendWardenDid, fwdEnvelope);
    if (cResult.status !== 'granted') {
      return { status: 'no-answer', reason: `friend did not answer (${cResult.status}${cResult.status !== 'no-answer' ? `: ${cResult.reason}` : ''})` };
    }

    // B's Emissary decrypts C's answer (B, the relay, learns it), keeping C's signature intact.
    await f.emissary.keymaster.setCurrentId(f.emissaryName);
    const cSigned = (await f.emissary.keymaster.decryptJSON(cResult.answerDid)) as MeshAnswer;

    // B's Warden signs a relay assertion (the trust-basis for the B→C edge), then re-encrypts to A.
    await km.setCurrentId(this.wardenName);
    const relayBody: RelayAssertion = {
      relayedBy: myDid,
      answerer: cSigned.answeredBy,
      edgeConfidence: friend.confidence,
      recognitionId: friend.recognitionId,
      forwardedAt: new Date().toISOString(),
    };
    const relay = (await km.addProof(relayBody, this.wardenName)) as RelayAssertion;
    const forwarded: ForwardedAnswer = { answer: cSigned, relay };
    const answerDid = await km.encryptJSON(forwarded, incoming.presenterDid, { registry: this.config.registry }); // pairwise to A's Emissary
    return { status: 'granted', answerDid };
  }
}

// ── Return + verify (A's Emissary) ─────────────────────────────────────────────────────────────────────

export interface ReceivedAnswer {
  ok: boolean;
  reason?: string;
  answer?: MeshAnswer;
}

/**
 * A's Emissary decrypts the pairwise answer, verifies B's Warden's signature over the WHOLE graph (so the
 * provenance tag cannot be altered after receipt), and confirms the signer is the expected issuer. Returns
 * the evidence graph as a plain struct — presentation only.
 */
export async function receiveAnswer(args: {
  emissary: KeymasterHandle;
  emissaryName: string;
  answerDid: string;
  expectedIssuer: string;
}): Promise<ReceivedAnswer> {
  const km = args.emissary.keymaster;
  await km.setCurrentId(args.emissaryName);
  let answer: MeshAnswer;
  try {
    answer = (await km.decryptJSON(args.answerDid)) as MeshAnswer;
  } catch (e) {
    return { ok: false, reason: `could not decrypt the answer (not the recipient?): ${e instanceof Error ? e.message : String(e)}` };
  }
  const verifyProof = km.verifyProof.bind(km) as (o: unknown) => Promise<boolean>;
  if (!answer.proof) return { ok: false, reason: 'answer carries no signature' };
  if (!(await verifyProof(answer).catch(() => false))) return { ok: false, reason: "B's Warden signature does not verify (tampered evidence graph)" };
  const signer = (answer.proof.verificationMethod ?? '').split('#')[0];
  if (signer !== args.expectedIssuer) return { ok: false, reason: `answer signed by ${signer}, not the expected issuer ${args.expectedIssuer}` };
  return { ok: true, answer };
}

// ── Depth-2 return: verify + mesh-assembled path provenance (verification ≠ recognition) ──────────────────

/** One trust edge in the assembled path. `basis` names WHY the edge exists — never "A recognizes C". */
export interface PathEdge {
  from: string;
  to: string;
  basis: string;
  confidence: number;
}

export interface ReceivedForwardedAnswer {
  ok: boolean;
  reason?: string;
  /** The failing check on rejection, e.g. 'relay' | 'answerer' | 'confidence'. */
  check?: string;
  answer?: MeshAnswer;
  /** The cryptographically VERIFIED answer signer (C). Verification is NOT recognition (see below). */
  verifiedSigner?: string;
  /** The relay A actually recognizes (B). */
  recognizedRelay?: string;
  /** The trust path, assembled by the mesh: A →(recognizes)→ B →(recognizes)→ C. NEVER an A→C edge. */
  path?: PathEdge[];
  /** Composed path confidence = product of edge confidences (≤ any single hop). */
  pathConfidence?: number;
  /**
   * STRUCTURAL guarantee: A does NOT recognize the answerer — it only verified its signature. Always
   * `false` for a relayed answer. Verifying C's signature must never be recorded as recognizing C.
   */
  recognizesAnswerer: boolean;
}

/**
 * A's Emissary decrypts a forwarded answer and lets the MESH (not the caller) assemble path provenance:
 *  - verifies the RELAY assertion, signed by the relay A recognizes (B) — A trusts B's forwarding claim;
 *  - VERIFIES the answerer's signature (C) cryptographically — this is verification, NOT recognition;
 *  - binds the two (the relay must name the same answerer that signed);
 *  - assembles the path `A →recognizes→ B →recognizes→ C` and composes the confidence, recording
 *    `recognizesAnswerer: false` so "A trusts C" is never implied.
 */
export async function receiveForwardedAnswer(args: {
  emissary: KeymasterHandle;
  emissaryName: string;
  answerDid: string;
  /** A's own DID (path origin). */
  self: string;
  /** The relay A recognizes (B's Warden DID). */
  expectedRelay: string;
  /** The A→B edge confidence — from B's recognition of A, which A holds. */
  relayEdgeConfidence: number;
}): Promise<ReceivedForwardedAnswer> {
  const km = args.emissary.keymaster;
  await km.setCurrentId(args.emissaryName);
  let fwd: ForwardedAnswer;
  try {
    fwd = (await km.decryptJSON(args.answerDid)) as ForwardedAnswer;
  } catch (e) {
    return { ok: false, reason: `could not decrypt (not the recipient?): ${e instanceof Error ? e.message : String(e)}`, recognizesAnswerer: false };
  }
  const verifyProof = km.verifyProof.bind(km) as (o: unknown) => Promise<boolean>;
  const { answer, relay } = fwd;

  // 1. The RELAY assertion — A recognizes B, so A trusts B's signed forwarding claim.
  if (!relay?.proof) return { ok: false, reason: 'no relay assertion', recognizesAnswerer: false };
  if (!(await verifyProof(relay).catch(() => false))) return { ok: false, reason: 'relay assertion signature does not verify', recognizesAnswerer: false };
  const relaySigner = (relay.proof.verificationMethod ?? '').split('#')[0];
  if (relaySigner !== args.expectedRelay) return { ok: false, reason: `relayed by ${relaySigner}, not the recognized relay ${args.expectedRelay}`, recognizesAnswerer: false };

  // 2. The ANSWERER's signature (C) — VERIFIED, not recognized. A has no recognition of C.
  if (!answer?.proof) return { ok: false, reason: 'answer carries no signature', recognizesAnswerer: false };
  if (!(await verifyProof(answer).catch(() => false))) return { ok: false, reason: "answerer's signature does not verify (tampered graph)", recognizesAnswerer: false };
  const answerSigner = (answer.proof.verificationMethod ?? '').split('#')[0];
  if (answerSigner !== relay.answerer) return { ok: false, reason: `answer signed by ${answerSigner}, but the relay names answerer ${relay.answerer}`, recognizesAnswerer: false };

  // 3. Confidence must be a probability in [0,1]. This BOUNDS a recognized-but-dishonest relay: without it,
  //    a relay reporting edgeConfidence 1.2 would AMPLIFY the path confidence above the A→B edge and break
  //    monotonicity. The clamp is a bound only — accuracy still rests on B's honesty (see FINDINGS).
  const inUnit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!inUnit(args.relayEdgeConfidence)) {
    return { ok: false, reason: `relayEdgeConfidence ${String(args.relayEdgeConfidence)} is not a probability in [0,1]`, check: 'confidence', recognizesAnswerer: false };
  }
  if (!inUnit(relay.edgeConfidence)) {
    return { ok: false, reason: `relay-reported edgeConfidence ${String(relay.edgeConfidence)} is not a probability in [0,1] (a relay cannot amplify path confidence)`, check: 'confidence', recognizesAnswerer: false };
  }

  // 4. Mesh-assembled path — A →recognizes→ B →recognizes→ C. No A→C edge is ever synthesized.
  const path: PathEdge[] = [
    { from: args.self, to: args.expectedRelay, basis: 'A recognizes B', confidence: args.relayEdgeConfidence },
    { from: args.expectedRelay, to: answerSigner, basis: 'B recognizes C', confidence: relay.edgeConfidence },
  ];
  const pathConfidence = args.relayEdgeConfidence * relay.edgeConfidence;
  return { ok: true, answer, verifiedSigner: answerSigner, recognizedRelay: args.expectedRelay, path, pathConfidence, recognizesAnswerer: false };
}
