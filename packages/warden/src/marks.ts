/**
 * SevenfoldMark issuance — Warden-issued, retiring the P0 demo-issuer caveat.
 *
 * A Mark is a VC the Warden issues to the Sovereign when a real, re-counted threshold is met (e.g. the
 * Library deck ≥ 25 → "Librarian I"). Issuance is **explicit** — the Sovereign claims; the Warden
 * verifies the count and issues (never automatic / surprise issuance). The Mark is **axes-free** (no
 * City Key vertex until the PrivacyMage pact lands).
 */

import { ensureSchema, openSchema, issueClaim, type KeymasterHandle } from '@hearthold/core';

import { VaultStore } from './store.js';
import type { MarkCandidate, MarkStatus, MarkClaimResult } from '@hearthold/control-types';

/** The P0 on-node SevenfoldMark schema (alias `sevenfold-mark-schema`). */
export const SEVENFOLD_MARK_SCHEMA_DID = 'did:cid:bagaaieraxtfpniplwvhxu5nuti4hzzc75dyoiighmqervqebgnfnxrlizz5q';

/**
 * Resolve the SevenfoldMark schema DID: prefer the P0 on-node schema (seed it under the alias so we
 * re-resolve, never re-create), else register one idempotently via `ensureSchema` (test / offline).
 */
export async function ensureMarkSchema(warden: KeymasterHandle): Promise<string> {
  const resolves = await warden.keymaster
    .getSchema(SEVENFOLD_MARK_SCHEMA_DID)
    .then((s) => s != null, () => false);
  if (resolves) return SEVENFOLD_MARK_SCHEMA_DID;
  return ensureSchema(warden, 'sevenfold-mark-schema', openSchema('SevenfoldMark'));
}

/** How many vault artefacts count toward a Mark's spec (axes-free: kind match only for P1). */
async function countFor(warden: KeymasterHandle, spec: MarkCandidate['spec']): Promise<number> {
  const items = await new VaultStore(warden.dataFolder).list();
  return items.filter((a) => !spec.kind || a.kind === spec.kind).length;
}

/** For each candidate Mark, the current count and whether it's claimable (count ≥ threshold). */
export async function claimableMarks(warden: KeymasterHandle, candidates: MarkCandidate[]): Promise<MarkStatus[]> {
  return Promise.all(
    candidates.map(async (c) => {
      const count = await countFor(warden, c.spec);
      return { markName: c.markName, count, threshold: c.threshold, claimable: count >= c.threshold };
    }),
  );
}

/**
 * Claim a Mark. The Warden **re-counts** (never trusts the Table's count); if the threshold is met it
 * issues an axes-free SevenfoldMark VC to `subjectDid`. Returns the credential DID, or a not-yet result.
 */
export async function claimMark(
  warden: KeymasterHandle,
  args: { candidate: MarkCandidate; subjectDid: string },
): Promise<MarkClaimResult> {
  const { candidate, subjectDid } = args;
  const count = await countFor(warden, candidate.spec);
  if (count < candidate.threshold) {
    return { issued: false, markName: candidate.markName, count, threshold: candidate.threshold };
  }
  const schemaDid = await ensureMarkSchema(warden);
  const credentialDid = await issueClaim(warden, subjectDid, schemaDid, {
    type: 'SevenfoldMark',
    mark: candidate.markName,
    count, // axes-free — no `axes` claim until the PrivacyMage pact lands
  });
  return { issued: true, markName: candidate.markName, count, threshold: candidate.threshold, credentialDid };
}
