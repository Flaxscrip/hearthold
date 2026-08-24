/**
 * Durable, collision-free status-list index allocation.
 *
 * Status-list indices were assigned randomly with NO persistent record of what had been allocated. That is
 * a correctness bound, not a privacy nicety: random assignment over 131,072 slots hits birthday collisions
 * sooner than intuition suggests (~14% odds of a collision by 200 issued recognitions, ~even by ~400). A
 * collision is not cosmetic — two recognitions share a bit, so revoking one SILENTLY revokes the other, or a
 * new recognition is born revoked because its slot was already set. Neither is visible at issuance.
 *
 * The fix: the issuing Sovereign keeps a durable AllocationRecord (recognitionId → statusListIndex) as an
 * Archon asset it OWNS and SEALS TO ITSELF (`sealForWarden` to its own DID). Two assets total — the PUBLIC
 * bitstring (verifiers fetch it) and this SEALED record (only the Sovereign reads it). Sealing costs nothing
 * in herd privacy: herd privacy is about what a VERIFIER learns from the public list; the issuer already
 * knows who it issued to, so recording that in its own sealed vault reveals nothing new.
 *
 * Concurrency: optimistic, version-pinned. Read the record at version N; before writing, re-check the head
 * is still N — if it moved, a concurrent issuance allocated, so re-read and retry. A post-write verify (our
 * mapping survived and its index is unique) is the authoritative backstop. Archon stays dumb: it just
 * stores/versions/controller-checks the opaque sealed blob. No in-memory fallback — allocation is durable or
 * construction fails.
 */

import { randomInt } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import type { HearthholdConfig } from './config.js';
import { sealForWarden, unsealAsWarden } from './payload.js';

interface AllocationRecordBody {
  /** recognitionId → statusListIndex. */
  allocations: Record<string, number>;
}

/** Create an empty AllocationRecord asset, sealed to the issuing Sovereign's own key. Returns its DID. */
export async function createAllocationRecord(issuer: KeymasterHandle, issuerName: string, config: HearthholdConfig): Promise<string> {
  const km = issuer.keymaster;
  await km.setCurrentId(issuerName);
  const issuerDid = (await km.resolveDID(issuerName)).didDocument?.id ?? '';
  const sealed = await sealForWarden(issuer, issuerDid, JSON.stringify({ allocations: {} } satisfies AllocationRecordBody));
  return km.createAsset({ sealed }, { registry: config.registry });
}

/** Read + unseal the record; returns it with the current versionSequence (for optimistic concurrency). */
async function readRecord(issuer: KeymasterHandle, allocationRecord: string): Promise<{ record: AllocationRecordBody; version: number }> {
  const doc = await issuer.keymaster.resolveDID(allocationRecord);
  const version = Number(((doc.didDocumentMetadata ?? {}) as { versionSequence?: string }).versionSequence ?? 0);
  const data = (doc.didDocumentData ?? {}) as { sealed?: string };
  if (typeof data.sealed !== 'string') throw new Error('allocation record missing or malformed');
  const record = JSON.parse(await unsealAsWarden(issuer, data.sealed)) as AllocationRecordBody;
  if (!record || typeof record.allocations !== 'object') throw new Error('allocation record malformed after unseal');
  return { record, version };
}

const headVersion = async (issuer: KeymasterHandle, allocationRecord: string): Promise<number> =>
  Number(((await issuer.keymaster.resolveDID(allocationRecord)).didDocumentMetadata as { versionSequence?: string } | undefined)?.versionSequence ?? 0);

/** Pick a RANDOM free index in `[0, space)`. Throws (never reuses) when the space is exhausted. */
function pickFree(used: Set<number>, space: number): number {
  if (used.size >= space) throw new Error(`status list exhausted: all ${space} indices are allocated (rolling to a fresh status list is deferred)`);
  for (let t = 0; t < 100_000; t++) {
    const i = randomInt(space);
    if (!used.has(i)) return i;
  }
  for (let i = 0; i < space; i++) if (!used.has(i)) return i; // dense fallback
  throw new Error(`status list exhausted: all ${space} indices are allocated (rolling to a fresh status list is deferred)`);
}

export interface AllocateOptions {
  maxRetries?: number;
  /** Test seam: runs once (after read, before write) to force a concurrent update and exercise the retry. */
  beforeWrite?: () => Promise<void>;
}

/**
 * Allocate a durable, unique index for `recognitionId`. Idempotent (returns the existing index). Picks a
 * RANDOM free slot, records it in the sealed record, and returns `{ index, attempts }`. Retries on a version
 * conflict; throws on exhaustion or after `maxRetries` conflicts (a correct error, never a silent reuse).
 */
export async function allocateIndex(
  issuer: KeymasterHandle,
  issuerName: string,
  allocationRecord: string,
  recognitionId: string,
  space: number,
  opts: AllocateOptions = {},
): Promise<{ index: number; attempts: number }> {
  const km = issuer.keymaster;
  const maxRetries = opts.maxRetries ?? 8;
  await km.setCurrentId(issuerName);
  const issuerDid = (await km.resolveDID(issuerName)).didDocument?.id ?? '';

  for (let attempt = 1; ; attempt++) {
    await km.setCurrentId(issuerName);
    const { record, version } = await readRecord(issuer, allocationRecord);
    const existing = record.allocations[recognitionId];
    if (typeof existing === 'number') return { index: existing, attempts: attempt };

    const index = pickFree(new Set(Object.values(record.allocations)), space); // throws on exhaustion

    if (attempt === 1 && opts.beforeWrite) await opts.beforeWrite(); // let a concurrent issuance land first

    // Optimistic CAS: the head must still be the version we read. If it moved, retry against the new state.
    if ((await headVersion(issuer, allocationRecord)) !== version) {
      if (attempt > maxRetries) throw new Error('allocation aborted: too many version conflicts');
      continue;
    }
    const next: AllocationRecordBody = { allocations: { ...record.allocations, [recognitionId]: index } };
    const sealed = await sealForWarden(issuer, issuerDid, JSON.stringify(next));
    try {
      await km.mergeData(allocationRecord, { sealed });
    } catch {
      if (attempt > maxRetries) throw new Error('allocation aborted: too many write conflicts');
      continue; // gatekeeper rejected a stale update → retry
    }

    // Authoritative check: our mapping survived and its index is unique (nobody clobbered / collided).
    const { record: after } = await readRecord(issuer, allocationRecord);
    if (after.allocations[recognitionId] === index && Object.values(after.allocations).filter((v) => v === index).length === 1) {
      return { index, attempts: attempt };
    }
    if (attempt > maxRetries) throw new Error('allocation aborted: post-write verification kept failing');
  }
}

/** Resolve `recognitionId` → its allocated index through the record, or null if unallocated. */
export async function lookupIndex(issuer: KeymasterHandle, issuerName: string, allocationRecord: string, recognitionId: string): Promise<number | null> {
  await issuer.keymaster.setCurrentId(issuerName);
  const { record } = await readRecord(issuer, allocationRecord);
  const i = record.allocations[recognitionId];
  return typeof i === 'number' ? i : null;
}
