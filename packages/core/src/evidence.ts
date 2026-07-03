/**
 * The evidence graph — the Warden as evidence assembler and issuer.
 *
 * When a claim must be proven from the Sovereign's *witnessed* history (not a credential anyone
 * already holds), the Warden selects the supporting vault artefacts, summarizes them into a
 * hash-committed provenance group, and mints a signed Verifiable Credential asserting the claim.
 * The verifier trusts the Warden's signature as it would any issuer (trust class `witnessed`).
 *
 * A1 commits to the *artefact set* (a Merkle root over artefact ids) and summarizes metadata
 * (count / window / witness) — no plaintext is read, nothing sensitive crosses. The Sovereign
 * co-signature (`approval`, for HIGH/SEALED) and per-leaf selective disclosure are later milestones.
 * See docs/evidence-graph.md.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import { ensureSchema, openSchema } from './schema.js';
import { Sensitivity } from './security.js';
import type {
  WitnessKind,
  EvidenceClaimSpec,
  EvidenceApprovalStatement,
  SignedEvidenceApproval,
} from './protocol.js';

export const HEARTHOLD_EVIDENCE_CONTEXT = 'https://hearthold.dev/2026/evidence/v1';
export const HEARTHOLD_ATTESTATION_TYPE = 'HearthholdAttestation';

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Metadata the assembler needs from a vault artefact — never its ciphertext or plaintext. */
export interface ArtefactMeta {
  id: string;
  kind: WitnessKind;
  observedAt: string;
  sensitivity: number;
  witnessedBy?: string;
}

/** A revealed per-observation leaf — its salted digest is a Merkle leaf under the group's signed root. */
export interface MerkleStep {
  hash: string;
  position: 'left' | 'right';
}
export interface RevealedLeaf {
  index: number;
  kind: string;
  observedAt: string;
  /** Random per-leaf salt so unrevealed low-entropy leaves can't be brute-forced. */
  salt: string;
  /** Sibling hashes from leaf to root. */
  path: MerkleStep[];
}

/** A summarized, hash-committed group of supporting artefacts (W3C `evidence` entry). */
export interface EvidenceGroup {
  id: string;
  type: string[];
  kind: WitnessKind;
  observedFrom: string;
  observedTo: string;
  count: number;
  witnessedBy: string[];
  commitment: { alg: 'sha256'; merkleRoot: string; artefactIds: string };
  disclosure: 'summary' | 'selective';
  /** Selectively-revealed leaves, verifiable against `commitment.merkleRoot` (A3). */
  revealed?: RevealedLeaf[];
}

/** Per-artefact leaf data the Warden retains to build the tree and reveal on request. */
export interface LeafData {
  index: number;
  kind: string;
  observedAt: string;
  salt: string;
  hash: string;
}

export interface AssembledEvidence {
  group: EvidenceGroup;
  /** Max sensitivity across the selected artefacts — governs the release decision. */
  sensitivity: number;
  artefactIds: string[];
  /** Salted per-observation leaves (index-stable) for selective disclosure. */
  leaves: LeafData[];
}

/** Salted per-observation leaf digest — random salt hides low-entropy leaves that stay unrevealed. */
const leafDigest = (salt: string, kind: string, observedAt: string): string =>
  sha256hex(`${salt}|${JSON.stringify({ kind, observedAt })}`);

/** Build a binary Merkle tree (order-preserving; last duplicated if odd). Returns the root + layers. */
function buildMerkle(leaves: string[]): { root: string; layers: string[][] } {
  if (leaves.length === 0) return { root: '', layers: [[]] };
  const layers: string[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i] as string;
      const b = cur[i + 1] ?? (cur[i] as string);
      next.push(sha256hex(a + b));
    }
    layers.push(next);
    cur = next;
  }
  return { root: cur[0] as string, layers };
}

function merklePath(layers: string[][], index: number): MerkleStep[] {
  const path: MerkleStep[] = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l] as string[];
    const right = idx % 2 === 1;
    const sib = layer[right ? idx - 1 : idx + 1] ?? (layer[idx] as string);
    path.push({ hash: sib, position: right ? 'left' : 'right' });
    idx = Math.floor(idx / 2);
  }
  return path;
}

/** Verify a leaf digest reaches `root` along `path`. */
export function verifyMerklePath(leaf: string, path: MerkleStep[], root: string): boolean {
  if (root.length === 0) return false;
  let h = leaf;
  for (const s of path) h = s.position === 'left' ? sha256hex(s.hash + h) : sha256hex(h + s.hash);
  return h === root;
}

/** Reveal chosen leaves (by index) from an assembled group — `{kind, observedAt, salt, path}` each. */
export function revealLeaves(assembled: AssembledEvidence, indices: number[]): RevealedLeaf[] {
  const { layers } = buildMerkle(assembled.leaves.map((l) => l.hash));
  const seen = new Set<number>();
  const out: RevealedLeaf[] = [];
  for (const i of indices) {
    if (i < 0 || i >= assembled.leaves.length || seen.has(i)) continue;
    seen.add(i);
    const l = assembled.leaves[i] as LeafData;
    out.push({ index: i, kind: l.kind, observedAt: l.observedAt, salt: l.salt, path: merklePath(layers, i) });
  }
  return out;
}

/** Verify a revealed leaf against a signed Merkle root — recompute the salted digest, check the path. */
export function verifyRevealedLeaf(r: RevealedLeaf, root: string): boolean {
  return verifyMerklePath(leafDigest(r.salt, r.kind, r.observedAt), r.path, root);
}

/** Select artefacts matching a claim spec (kind + observed-time window). */
export function selectArtefacts(metas: ArtefactMeta[], spec: EvidenceClaimSpec): ArtefactMeta[] {
  return metas.filter((m) => {
    if (m.kind !== spec.kind) return false;
    if (spec.from && m.observedAt < spec.from) return false;
    if (spec.to && m.observedAt > spec.to) return false;
    return true;
  });
}

/** Assemble a hash-committed evidence group over the matching artefacts, or null if none match. */
export function assembleEvidence(
  metas: ArtefactMeta[],
  spec: EvidenceClaimSpec,
): AssembledEvidence | null {
  const selected = selectArtefacts(metas, spec).sort((a, b) =>
    a.observedAt.localeCompare(b.observedAt),
  );
  if (selected.length === 0) return null;

  const ids = selected.map((m) => m.id);
  const leaves: LeafData[] = selected.map((m, i) => {
    const salt = randomBytes(16).toString('hex');
    return { index: i, kind: m.kind, observedAt: m.observedAt, salt, hash: leafDigest(salt, m.kind, m.observedAt) };
  });
  const { root } = buildMerkle(leaves.map((l) => l.hash));
  const witnesses = [...new Set(selected.map((m) => m.witnessedBy).filter((w): w is string => !!w))];
  const sensitivity = selected.reduce((mx, m) => Math.max(mx, m.sensitivity), Sensitivity.PUBLIC as number);
  const first = selected[0] as ArtefactMeta;
  const last = selected[selected.length - 1] as ArtefactMeta;

  const group: EvidenceGroup = {
    id: `urn:hearthold:ev:${spec.kind}`,
    type: ['HearthholdArtefactGroup'],
    kind: spec.kind,
    observedFrom: first.observedAt,
    observedTo: last.observedAt,
    count: selected.length,
    witnessedBy: witnesses,
    commitment: { alg: 'sha256', merkleRoot: root, artefactIds: `merkle:sha256:${root}` },
    disclosure: 'summary',
  };
  return { group, sensitivity, artefactIds: ids, leaves };
}

/**
 * A reference to a third-party `issued` credential, composed into the graph as a leaf. The verifier
 * trusts the **external issuer's** signature — the strongest leaf class (see docs/evidence-graph.md).
 * It is a *reference*; the underlying VC is presented alongside so the verifier can check it directly.
 */
export interface IssuedLeafRef {
  id: string;
  type: ['HearthholdIssuedLeaf'];
  trustClass: 'issued';
  credentialDid: string;
  issuer: string;
  schema?: string;
  credentialType: string;
  descriptionSource: 'issuer-asserted';
}

export interface MintEvidenceArgs {
  /** The Sovereign — the claim is about them. */
  subjectDid: string;
  claim: string;
  structured?: Record<string, unknown>;
  evidence: EvidenceGroup[];
  /** Third-party `issued` leaves composed alongside the witnessed evidence. */
  issuedLeaves?: IssuedLeafRef[];
  /** Single-use transaction id (R1). */
  txn: string;
  /** When the ephemeral proof expires. */
  validUntil?: string;
  /** The Sovereign-signed approval, embedded verbatim (carries its own `proof`). */
  approval?: SignedEvidenceApproval;
}

/**
 * Mint the evidence graph as a Warden-issued VC. Returns the credential DID + the schema DID the
 * verifier challenges by. The provenance lives in `credentialSubject.evidence` (round-trips through
 * Keymaster) and is mirrored to the standard top-level `evidence` field.
 */
export async function mintEvidenceGraph(
  warden: KeymasterHandle,
  args: MintEvidenceArgs,
): Promise<{ credentialDid: string; schemaDid: string }> {
  const schemaDid = await ensureSchema(
    warden,
    HEARTHOLD_ATTESTATION_TYPE,
    openSchema(HEARTHOLD_ATTESTATION_TYPE),
  );
  const issued = args.issuedLeaves ?? [];
  const allEvidence = [...args.evidence, ...issued];
  const trustClass = issued.length > 0 ? 'composite' : 'witnessed';
  const bound = await warden.keymaster.bindCredential(args.subjectDid, {
    schema: schemaDid,
    validUntil: args.validUntil,
    claims: {
      type: HEARTHOLD_ATTESTATION_TYPE,
      claim: args.claim,
      structured: args.structured ?? {},
      evidence: allEvidence,
      trustClass,
      descriptionSource: 'machine-derived',
      txn: args.txn,
      ...(args.approval ? { approval: args.approval } : {}),
    },
  });

  bound.type = ['VerifiableCredential', HEARTHOLD_ATTESTATION_TYPE];
  const ctx = ((bound['@context'] as string[] | undefined) ?? []).filter(
    (c) => !c.includes('/credentials/examples/'),
  );
  if (!ctx.includes(HEARTHOLD_EVIDENCE_CONTEXT)) ctx.push(HEARTHOLD_EVIDENCE_CONTEXT);
  bound['@context'] = ctx;

  const extra = bound as unknown as Record<string, unknown>;
  extra.evidence = allEvidence;
  extra.termsOfUse = [{ type: 'HearthholdSingleUse', txn: args.txn }];

  const credentialDid = await warden.keymaster.issueCredential(bound, {
    schema: schemaDid,
    validUntil: args.validUntil,
  });
  return { credentialDid, schemaDid };
}

// ── Step-up: the Sovereign co-signs a sensitive disclosure (A2) ───────────────

/** Proof-of-human assurance level required to externally disclose data at a given sensitivity. */
export function requiredLevelFor(sensitivity: number): number {
  if (sensitivity >= Sensitivity.SEALED) return 2; // multifactor
  if (sensitivity >= Sensitivity.MEDIUM) return 1; // a fresh proof-of-human (PIN+)
  return 0; // standing delegation suffices (A1)
}

export interface ApprovalHumanProof {
  method: string;
  level: number;
  timestamp: string;
}

/**
 * The Sovereign co-signs one specific disclosure: it signs the approval statement (bound to the
 * claim + evidence root, carrying the Signet's proof-of-human assertion) with its own key via
 * `keymaster.addProof` — a **detached secp256k1 signature** anyone can verify against the Sovereign's
 * DID, no decryption needed. The signed statement is embedded verbatim in the evidence graph. The
 * Signet gates whether this is produced at all.
 */
export async function signEvidenceApproval(
  sovereign: KeymasterHandle,
  statement: EvidenceApprovalStatement,
): Promise<SignedEvidenceApproval> {
  return (await sovereign.keymaster.addProof(statement)) as SignedEvidenceApproval;
}

export interface ApprovalCheck {
  ok: boolean;
  reason: string;
  approver?: string;
  txn?: string;
  humanProof?: ApprovalHumanProof;
}

/**
 * The Warden verifies a Sovereign approval: the detached signature is valid AND made by the expected
 * Sovereign, and the statement binds to *this* disclosure (same claim + evidence root) with a
 * sufficient proof-of-human level. No decryption — `verifyProof` resolves the signer's DID key.
 */
export async function verifyEvidenceApproval(
  warden: KeymasterHandle,
  signed: SignedEvidenceApproval | undefined,
  expect: { approver: string; claim: string; evidenceRoot: string; requiredLevel: number },
): Promise<ApprovalCheck> {
  if (!signed || !signed.proof) return { ok: false, reason: 'approval is not signed' };

  const proof = signed.proof as { verificationMethod?: string };
  const signerDid = String(proof.verificationMethod ?? '').split('#')[0] ?? '';
  if (signerDid !== expect.approver) return { ok: false, reason: 'approval not signed by the Sovereign' };
  const verifyProof = warden.keymaster.verifyProof.bind(warden.keymaster) as (o: unknown) => Promise<boolean>;
  if (!(await verifyProof(signed).catch(() => false))) {
    return { ok: false, reason: "the Sovereign's signature does not verify" };
  }
  if (signed.approver !== expect.approver) return { ok: false, reason: 'approver mismatch' };
  if (signed.claim !== expect.claim) return { ok: false, reason: 'approval does not match the claim' };
  if (signed.evidenceRoot !== expect.evidenceRoot) {
    return { ok: false, reason: 'approval does not match the evidence root' };
  }
  const hp = signed.humanProof;
  if (!hp || hp.level < expect.requiredLevel) {
    return { ok: false, reason: `proof-of-human level ${hp?.level ?? 0} below required ${expect.requiredLevel}` };
  }
  return { ok: true, reason: 'approved', approver: signerDid, txn: signed.txn, humanProof: hp };
}
