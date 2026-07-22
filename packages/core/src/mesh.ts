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

/** What B's admission policy needs to see. A discloses ONLY these; domain/mode/maxDepth stay hidden. */
export const RECOGNITION_DISCLOSE = ['subject', 'tier', 'recognitionId', 'confidence'] as const;

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
  depth: number;
  budget: QueryBudget;
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

/** B's admission policy (v1: single tier, arrival depth 1 only). */
export interface MeshPolicy {
  /** The Sovereign whose recognitions B honors (B's own Sovereign). */
  recognizedIssuer: string;
  tier: string;
  maxArrivalDepth: number;
  /** Revoked recognitionIds. B revokes by adding here (v1 in-memory; publishable as an Archon asset later). */
  revoked: Set<string>;
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
  proof?: { verificationMethod: string; proofValue: string; created: string; [k: string]: unknown };
}

export type MeshResult =
  | { status: 'granted'; answerDid: string }
  | { status: 'rejected'; reason: string; check: string };

/** v1 reasoning: a keyword lookup over the seeded public partition (an LLM call would slot in here). */
export function reasonOverPartition(query: MeshQuery, partition: PublicPartition): PartitionFact | null {
  if (query.domain !== partition.domain) return null;
  const q = query.text.toLowerCase();
  return partition.facts.find((f) => f.keywords.some((k) => q.includes(k))) ?? null;
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
  ) {}

  /** Admission — deny-by-default. Returns the disclosed recognition fields on ACCEPT. */
  async admit(envelope: MeshQueryEnvelope): Promise<{ ok: boolean; reason?: string; check?: string; disclosed?: Record<string, unknown> }> {
    // 1. The recognition must verify AND be issued by the Sovereign B recognizes (its own).
    const v = await verifyPresentation(envelope.recognition, { keymaster: this.warden, expectedIssuer: this.policy.recognizedIssuer });
    if (!v.ok) return { ok: false, reason: `recognition not honored: ${v.reason}`, check: v.check === 'issuer' ? 'recognition' : v.check ?? 'recognition' };
    const d = v.disclosed ?? {};

    // 2. It must name the presenter (the admission token is bound to A's Emissary).
    if (d.subject !== envelope.presenterDid) return { ok: false, reason: 'recognition does not name the presenting Emissary', check: 'binding' };

    // 3. Tier (v1: single recognized tier).
    if (d.tier !== this.policy.tier) return { ok: false, reason: `tier '${String(d.tier)}' is not recognized (need '${this.policy.tier}')`, check: 'tier' };

    // 4. Revocation.
    if (typeof d.recognitionId === 'string' && this.policy.revoked.has(d.recognitionId)) {
      return { ok: false, reason: 'recognition has been revoked by B', check: 'revocation' };
    }

    // 5. Arrival depth (v1: depth-1 partition only).
    if (envelope.query.depth !== this.policy.maxArrivalDepth) {
      return { ok: false, reason: `arrival depth ${envelope.query.depth} exceeds partition policy (depth ${this.policy.maxArrivalDepth} only)`, check: 'depth' };
    }
    return { ok: true, disclosed: d };
  }

  async handle(envelope: MeshQueryEnvelope): Promise<MeshResult> {
    const adm = await this.admit(envelope);
    if (!adm.ok) return { status: 'rejected', reason: adm.reason ?? 'admission denied', check: adm.check ?? 'admission' };

    const fact = reasonOverPartition(envelope.query, this.partition);
    if (!fact) return { status: 'rejected', reason: 'no answer in the public partition for that query', check: 'partition' };

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
    };
    const signed = (await km.addProof(body, this.wardenName)) as MeshAnswer; // B's Warden signs the graph
    const answerDid = await km.encryptJSON(signed, envelope.presenterDid, { registry: this.config.registry }); // pairwise to A's Emissary
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
