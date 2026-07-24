/**
 * The keep closure — "keep this credential" is a SUBGRAPH, not a document.
 *
 * To re-verify a credential independently years later you need the VC, its schema, and the issuer's
 * operations UP TO the version that signed it — not the hundreds of unrelated operations a full-chain
 * export dragged into the DMZ. Crucially, the closure is NOT computable from the credential alone: it
 * depends on WHAT YOU WANT TO PROVE LATER. So the verification GOAL is an input, not a fixed traversal:
 *
 *   - `signed-by X`             → X's operations to the signing version, the schema, the VC. Nothing more.
 *   - `signed-by-authorized`    → additionally X's authority (charter) credential and ITS issuer's chain.
 *
 * Everything is VERSION-PINNED: each kept DID records both its `versionSequence` AND the matching
 * content-addressed `versionId` (the opid at that version), exactly as attenuation pins versions — so the
 * kept ops are truncated to a cut that is itself cryptographically named, not "latest at export time".
 */

import type { GatekeeperEvent } from '@didcid/gatekeeper/types';

/** What we want to be able to prove later. The traversal differs per kind — do not collapse them. */
export type VerificationGoal =
  | { kind: 'signed-by'; issuer: string }
  | {
      kind: 'signed-by-authorized';
      issuer: string;
      /** The credential establishing the issuer's authority (its charter), and that charter's issuer. */
      authority: { credentialDid: string; authorityIssuer: string };
    };

/** A version-pinned cut of one DID: keep its ops from genesis through exactly this version. */
export interface OpPin {
  did: string;
  role: 'credential' | 'schema' | 'issuer' | 'authority-credential' | 'authority-issuer';
  /** 1-based (create = 1). The chain is kept as ops[0 .. versionSequence-1]. */
  versionSequence: number;
  /** The content-addressed opid at that version — the pin's cryptographic name, matches ops[versionSequence-1].opid. */
  versionId: string;
}

export interface KeepClosure {
  goal: VerificationGoal;
  /** One pin per kept DID, minimal for the goal. */
  pins: OpPin[];
  /** The kept operations per DID, each truncated from genesis to its pinned version. */
  ops: Record<string, GatekeeperEvent[]>;
  /** Total kept operations across all DIDs — the thing a naive full-export would blow up. */
  totalOps: number;
}

/** The inputs about the credential the closure needs that cannot be derived without decrypting it. */
export interface ClosureInput {
  credentialDid: string;
  /** The schema DID the VC conforms to. */
  schemaDid: string;
  /** ISO timestamp the VC was signed (its `proof.created`) — pins the issuer to its signing version. */
  signedAt: string;
  /** For `signed-by-authorized`: when the charter credential was signed (pins the authority issuer). */
  authoritySignedAt?: string;
}

/** The read surface the closure needs — satisfied by both the node's PrivateGatekeeper and a DMZ client. */
export interface ClosureSource {
  resolveDID(did: string, options?: { versionTime?: string }): Promise<{
    didDocumentMetadata?: { versionId?: string; versionSequence?: string | number };
    didDocument?: { id?: string };
  }>;
  exportDIDs(dids: string[]): Promise<GatekeeperEvent[][]>;
}

/** Resolve a DID (optionally at a version time) and read its pinned (versionSequence, versionId). Fail closed. */
async function pinVersion(source: ClosureSource, did: string, versionTime?: string): Promise<{ versionSequence: number; versionId: string }> {
  const doc = await source.resolveDID(did, versionTime ? { versionTime } : undefined);
  const meta = doc.didDocumentMetadata;
  const seq = meta?.versionSequence != null ? Number(meta.versionSequence) : NaN;
  const versionId = meta?.versionId;
  if (!doc.didDocument?.id || !Number.isFinite(seq) || !versionId) {
    throw new Error(`closure: cannot pin '${did}'${versionTime ? ` at ${versionTime}` : ''} — missing version metadata (fail closed)`);
  }
  return { versionSequence: seq, versionId };
}

/** Export a DID's full chain and truncate to its pinned version (genesis → cut). Verifies the cut's opid. */
async function keptOps(source: ClosureSource, did: string, versionSequence: number, versionId: string): Promise<GatekeeperEvent[]> {
  // `exportDIDs` may return MORE chains than requested — a referenced dependency can ride in (observed live
  // by Aegis: 3 DIDs requested → 4 chains returned, the issuer's node identity unrequested). The keep-set is
  // the REQUESTED set, never the returned set: select only the chain belonging to `did`; any dependency that
  // rode in is not kept (it stays in the DMZ and evaporates on teardown). Match by the per-event `did` tag,
  // use the sole chain when the export did not expand, and fail closed if the requested DID isn't identifiable.
  const batch = await source.exportDIDs([did]);
  const full =
    batch.length === 1
      ? batch[0]
      : batch.find((chain) => chain.some((ev) => (ev as { did?: string }).did === did));
  if (!full?.length) throw new Error(`closure: export did not yield the requested DID '${did}' (fail closed)`);
  if (versionSequence > full.length) {
    throw new Error(`closure: pinned version ${versionSequence} exceeds ${full.length} exported ops for '${did}'`);
  }
  const cut = full.slice(0, versionSequence);
  const lastOpid = (cut[cut.length - 1] as { opid?: string }).opid;
  if (lastOpid && versionId && lastOpid !== versionId) {
    throw new Error(`closure: version pin mismatch for '${did}' — cut ends at ${lastOpid}, expected ${versionId}`);
  }
  return cut;
}

/**
 * Compute the minimal, version-pinned operation set that lets `input.credentialDid` be re-verified against
 * `goal` — and nothing more. Two goals over the same credential yield DIFFERENT closures by construction:
 * `signed-by-authorized` adds the issuer's charter credential and that charter's issuer chain that
 * `signed-by` does not need.
 */
export async function computeKeepClosure(input: ClosureInput, goal: VerificationGoal, source: ClosureSource): Promise<KeepClosure> {
  const pins: OpPin[] = [];
  const ops: Record<string, GatekeeperEvent[]> = {};

  const keep = async (did: string, role: OpPin['role'], versionTime?: string): Promise<void> => {
    const { versionSequence, versionId } = await pinVersion(source, did, versionTime);
    ops[did] = await keptOps(source, did, versionSequence, versionId);
    pins.push({ did, role, versionSequence, versionId });
  };

  // Always: the VC (its own latest version), the schema it references, and the issuer TO ITS SIGNING VERSION
  // (pinned by the VC's proof time — later issuer key rotations are NOT needed to verify this signature).
  await keep(input.credentialDid, 'credential');
  await keep(input.schemaDid, 'schema');
  await keep(goal.issuer, 'issuer', input.signedAt);

  // Only `signed-by-authorized` reaches further: the charter proving the issuer's authority, and the chain
  // of whoever signed that charter. `signed-by` deliberately stops at the issuer.
  if (goal.kind === 'signed-by-authorized') {
    await keep(goal.authority.credentialDid, 'authority-credential');
    await keep(goal.authority.authorityIssuer, 'authority-issuer', input.authoritySignedAt);
  }

  const totalOps = Object.values(ops).reduce((n, arr) => n + arr.length, 0);
  return { goal, pins, ops, totalOps };
}
