import type { HearthholdConfig, KeymasterHandle } from '@hearthold/core';

import { VaultStore } from './store.js';

/**
 * Backfill vault artefact ownership for the family model (guardianship-threat-model.md §4 / Fable #4).
 *
 * Pre-family artefacts carry no `owner`. Attribute every ownerless personal-vault artefact to the
 * configured Sovereign (`config.sovereignDid`) with `scope: 'private'` — correct for all pre-family data,
 * since a single-Sovereign vault was entirely that Sovereign's. Idempotent: already-owned artefacts are
 * left untouched. Returns how many were attributed.
 *
 * (The recall index carries owner/scope on new writes; run `warden kb-reindex` afterwards to propagate
 * ownership to existing index entries so the Sovereign's own content survives session-scoped recall.)
 */
export async function backfillOwner(handle: KeymasterHandle, config: HearthholdConfig): Promise<number> {
  const sovereign = config.sovereignDid;
  if (!sovereign) throw new Error('no Sovereign configured (HEARTHOLD_SOVEREIGN_DID) — cannot attribute pre-family ownership');
  const store = new VaultStore(handle.dataFolder);
  const all = await store.list();
  let attributed = 0;
  for (const a of all) {
    if (a.owner) continue; // already attributed
    await store.put({ ...a, owner: sovereign, scope: a.scope ?? 'private' });
    attributed++;
  }
  return attributed;
}
