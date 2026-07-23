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
import type { RevocationResolver, RevocationListPin } from './revocation.js';

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
 * B's Sovereign issues a recognition credential naming A's Emissary, scoped. A fresh `recognitionId` rides
 * in the credential so B can revoke it. Returns the SD credential (commitments + disclosures + payload).
 */
export async function issueRecognition(args: {
  issuer: KeymasterHandle;
  issuerName: string;
  subject: string;
  scope: Omit<RecognitionScope, 'subject'>;
  registry: string;
}): Promise<IssuedDisclosureCredential & { recognitionId: string }> {
  const recognitionId = randomUUID();
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
    },
    credentialType: 'MeshRecognition',
    registry: args.registry,
  });
  return { ...cred, recognitionId };
}

/**
 * What an admission policy needs to see. A discloses these; domain/mode stay hidden. `maxDepth` is disclosed
 * (FIX-FIRST — depth authority): each hop must enforce how far the RECOGNITION authorized propagation, not
 * only its own partition policy. Effective reach at every hop = min(recognition-authorized, partition-permitted).
 */
export const RECOGNITION_DISCLOSE = ['subject', 'tier', 'recognitionId', 'confidence', 'maxDepth'] as const;

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
  /** Per-hop arrival depth — always 1 (each hop is a fresh 1-hop presentation to the next Warden). */
  depth: number;
  budget: QueryBudget;
  /**
   * Propagation budget (depth-2): forwards still allowed. A recognition of `maxDepth k` authorizes `k-1`
   * forwards from where it is presented. Set by the origin from its recognition; strictly decremented on
   * each forward. `< 1` ⇒ this node cannot forward. Absent ⇒ 0 (v1 answer-only).
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

/** A node's admission policy (v1: single tier, arrival depth 1 only). */
export interface MeshPolicy {
  /** The Sovereign whose recognitions this node honors (its own). */
  recognizedIssuer: string;
  tier: string;
  maxArrivalDepth: number;
  /**
   * Durable revocation — REQUIRED: a resolver over the issuer's published RevocationList asset (fail-closed,
   * version-pinned). There is no in-memory fallback; durability is not opt-in. For a node with no
   * revocations, point it at a freshly-created (empty) RevocationList. See revocation.ts.
   */
  revocation: RevocationResolver;
  /**
   * The partition-permitted forward axis (depth-2): how many forwards this node is willing to relay. The
   * effective reach at this hop is `min(recognition.maxDepth - 1, maxRelayDepth)` — whichever is tighter.
   * Absent ⇒ 0 (this node does not relay; v1 answer-only).
   */
  maxRelayDepth?: number;
}

/** One fact in B's public partition, with its provenance. */
export interface PartitionFact {
  ref: string;
  provenance: 'asserted' | 'inferred';
  confidence: number;
  narrative: string;
  keywords: string[];
}
export interface PublicPartition {
  domain: string;
  facts: PartitionFact[];
}

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
  /** Audit binding: when revocation was checked, and the exact pinned list version it was checked against. */
  revocationCheckedAt?: string;
  revocationListVersion?: RevocationListPin;
  proof?: { verificationMethod: string; proofValue: string; created: string; [k: string]: unknown };
}

export type MeshResult =
  | { status: 'granted'; answerDid: string }
  | { status: 'rejected'; reason: string; check: string }
  /** No local answer and no valid forward — a CLEAN miss, never a fabricated answer (BROKEN-RELAY). */
  | { status: 'no-answer'; reason: string };

/** v1 reasoning: a keyword lookup over the seeded public partition (an LLM call would slot in here). */
export function reasonOverPartition(query: MeshQuery, partition: PublicPartition): PartitionFact | null {
  if (query.domain !== partition.domain) return null;
  const q = query.text.toLowerCase();
  return partition.facts.find((f) => f.keywords.some((k) => q.includes(k))) ?? null;
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
 * edge, runs admission (recognition valid + names the presenter + tier + not revoked + arrival depth),
 * reasons over the public partition, and returns a signed answer pairwise-encrypted to A's Emissary.
 */
export class MeshWarden {
  constructor(
    private readonly warden: KeymasterHandle,
    private readonly wardenName: string,
    private readonly config: HearthholdConfig,
    private readonly policy: MeshPolicy,
    private readonly partition: PublicPartition,
    /** Depth-2: the forwarding capability (this node's Emissary + friend recognitions). Omit ⇒ answer-only. */
    private readonly forwarding?: MeshForwarding,
  ) {}

  /** Admission — deny-by-default. Returns the disclosed recognition fields (+ any revocation pin) on ACCEPT. */
  async admit(envelope: MeshQueryEnvelope): Promise<{ ok: boolean; reason?: string; check?: string; disclosed?: Record<string, unknown>; revocationPin?: RevocationListPin }> {
    // 1. The recognition must verify AND be issued by the Sovereign B recognizes (its own).
    const v = await verifyPresentation(envelope.recognition, { keymaster: this.warden, expectedIssuer: this.policy.recognizedIssuer });
    if (!v.ok) return { ok: false, reason: `recognition not honored: ${v.reason}`, check: v.check === 'issuer' ? 'recognition' : v.check ?? 'recognition' };
    const d = v.disclosed ?? {};

    // 2. It must name the presenter (the admission token is bound to A's Emissary).
    if (d.subject !== envelope.presenterDid) return { ok: false, reason: 'recognition does not name the presenting Emissary', check: 'binding' };

    // 3. Tier (v1: single recognized tier).
    if (d.tier !== this.policy.tier) return { ok: false, reason: `tier '${String(d.tier)}' is not recognized (need '${this.policy.tier}')`, check: 'tier' };

    // 4. Revocation — resolve the durable list, FAIL-CLOSED if the fact is unavailable. Carry the pin so the
    //    answer can bind the exact list version checked (after-the-fact dispute).
    const recognitionId = typeof d.recognitionId === 'string' ? d.recognitionId : '';
    const rc = await this.policy.revocation.check(recognitionId);
    if (!rc.available) return { ok: false, reason: `revocation status unavailable — deny (fail-closed): ${rc.reason}`, check: 'revocation' };
    if (rc.revoked) return { ok: false, reason: 'recognition has been revoked (published list)', check: 'revocation' };
    const revocationPin = rc.pin;

    // 5. Arrival depth (v1: depth-1 partition only — each hop is a fresh 1-hop presentation).
    if (envelope.query.depth !== this.policy.maxArrivalDepth) {
      return { ok: false, reason: `arrival depth ${envelope.query.depth} exceeds partition policy (depth ${this.policy.maxArrivalDepth} only)`, check: 'depth' };
    }

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
    return { ok: true, disclosed: d, revocationPin };
  }

  async handle(envelope: MeshQueryEnvelope): Promise<MeshResult> {
    const adm = await this.admit(envelope);
    if (!adm.ok) return { status: 'rejected', reason: adm.reason ?? 'admission denied', check: adm.check ?? 'admission' };

    // 1. Answer locally if we can.
    const fact = reasonOverPartition(envelope.query, this.partition);
    if (fact) {
      const km = this.warden.keymaster;
      await km.setCurrentId(this.wardenName);
      const answeredBy = (await km.resolveDID(this.wardenName)).didDocument?.id ?? '';
      const body: MeshAnswer = {
        reference: fact.ref,
        provenance: fact.provenance,
        factConfidence: fact.confidence,
        recognitionConfidence: Number(adm.disclosed?.confidence ?? 0),
        narrative: fact.narrative,
        domain: envelope.query.domain,
        answeredBy,
        answeredAt: new Date().toISOString(),
        // Bind the revocation check into the signed answer (audit): which list version proved not-revoked.
        revocationCheckedAt: adm.revocationPin ? new Date().toISOString() : undefined,
        revocationListVersion: adm.revocationPin,
      };
      const signed = (await km.addProof(body, this.wardenName)) as MeshAnswer; // this Warden signs the graph
      const answerDid = await km.encryptJSON(signed, envelope.presenterDid, { registry: this.config.registry }); // pairwise to the presenter
      return { status: 'granted', answerDid };
    }

    // 2. No local answer — forward once, if configured and authorized. Never a fabricated answer.
    if (!this.forwarding) return { status: 'rejected', reason: 'no answer in the public partition for that query', check: 'partition' };
    return this.forward(envelope);
  }

  /** Depth-2 relay: this node's Emissary crosses to a recognized friend, then this Warden re-packages. */
  private async forward(incoming: MeshQueryEnvelope): Promise<MeshResult> {
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

    // Attenuate the query for the forward (strictly decrement depthRemaining; scope/budget must be ⊆).
    const forwardQuery: MeshQuery = { ...incoming.query, depthRemaining: remaining - 1, visited: [...visited, myDid] };
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
