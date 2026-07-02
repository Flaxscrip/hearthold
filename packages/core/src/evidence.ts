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

import { createHash } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import { ensureSchema, openSchema } from './schema.js';
import { Sensitivity } from './security.js';
import type { WitnessKind, EvidenceClaimSpec } from './protocol.js';

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
  disclosure: 'summary';
}

export interface AssembledEvidence {
  group: EvidenceGroup;
  /** Max sensitivity across the selected artefacts — governs the release decision. */
  sensitivity: number;
  artefactIds: string[];
}

/** Binary Merkle root over hex leaves (sorted for determinism; last duplicated if odd). */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return '';
  let level = [...leaves].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i] as string;
      const b = level[i + 1] ?? a;
      next.push(sha256hex(a + b));
    }
    level = next;
  }
  return level[0] as string;
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
  const root = merkleRoot(ids.map((id) => sha256hex(id)));
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
  return { group, sensitivity, artefactIds: ids };
}

/** The Sovereign co-signature block, attached for HIGH/SEALED disclosures (A2). */
export interface EvidenceApproval {
  approver: string;
  txn: string;
  humanProof: { method: string; level: number; timestamp: string };
}

export interface MintEvidenceArgs {
  /** The Sovereign — the claim is about them. */
  subjectDid: string;
  claim: string;
  structured?: Record<string, unknown>;
  evidence: EvidenceGroup[];
  /** Single-use transaction id (R1). */
  txn: string;
  validUntil?: string;
  approval?: EvidenceApproval;
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
  const bound = await warden.keymaster.bindCredential(args.subjectDid, {
    schema: schemaDid,
    validUntil: args.validUntil,
    claims: {
      type: HEARTHOLD_ATTESTATION_TYPE,
      claim: args.claim,
      structured: args.structured ?? {},
      evidence: args.evidence,
      trustClass: 'witnessed',
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
  extra.evidence = args.evidence;
  extra.termsOfUse = [{ type: 'HearthholdSingleUse', txn: args.txn }];

  const credentialDid = await warden.keymaster.issueCredential(bound, {
    schema: schemaDid,
    validUntil: args.validUntil,
  });
  return { credentialDid, schemaDid };
}
