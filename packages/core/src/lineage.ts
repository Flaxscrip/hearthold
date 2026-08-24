/**
 * Lineage reconstruction — a watcher walks a capability chain by PUBLIC resolution only (zero decryption).
 *
 * Every hop is an Archon Asset DID carrying a cleartext `pic` block (lineageId, counter, a version-pinned parent
 * pointer, the signed attenuation assertion). So anyone who can resolve DIDs can reconstruct the STRUCTURE of a
 * chain from its leaf to the root — who delegated to whom, how deep, under which lineage — without holding any
 * secret and without decrypting anyone's private VC. This is what lets the Sovereign *watch* the family's live
 * delegation tree: the caveats (ceiling/kinds/status) stay in the committed+encrypted layer, but the shape and
 * provenance are public by construction. Revocation STATE is known to each hop's issuer (who holds the status
 * bit), not to a public walker — the watch layer annotates it from the issuers' own reports.
 */

import type { KeymasterHandle } from './keymaster.js';
import type { PicBlock } from './attenuation.js';

export interface LineageNode {
  /** This hop's Asset DID. */
  vcDid: string;
  /** Depth from the root (0 = root). */
  counter: number;
  /** The hop's controller = its issuer (the delegator that minted it). */
  controller: string;
  /** The issuer-attested holder of this hop (from its signed assertion) — who may invoke / further-delegate it. */
  holder: string;
  /** Stable across the whole chain (the origin's own DID). */
  lineageId: string;
}

/**
 * Reconstruct a chain's lineage from its leaf Asset DID, by public resolution, returning the hops **root → leaf**.
 * Follows each hop's version-pinned parent pointer (so it reads exactly the pinned historical version, not a
 * tampered-forward one). Reveals structure + provenance, never caveats. Stops at the origin (`prevCredential`
 * null) or after `maxHops`. A hop that doesn't resolve / carries no pic ends the walk (best-effort for a watcher).
 */
export async function reconstructLineage(handle: KeymasterHandle, leafVcDid: string, maxHops = 64): Promise<LineageNode[]> {
  const km = handle.keymaster;
  const out: LineageNode[] = [];
  let did = leafVcDid;
  let useVersion: number | undefined;

  for (let i = 0; i < maxHops; i++) {
    const doc = await km.resolveDID(did, useVersion !== undefined ? { versionSequence: useVersion } : undefined).catch(() => undefined);
    const controller = (doc?.didDocument as { controller?: string } | undefined)?.controller ?? '';
    const pic = (doc?.didDocumentData as { pic?: PicBlock } | undefined)?.pic;
    if (!pic) break;
    out.push({
      vcDid: did,
      counter: pic.counter,
      controller,
      holder: pic.attenuationAssertion?.holder ?? '',
      lineageId: pic.lineageId,
    });
    if (pic.prevCredential === null) break;
    did = pic.prevCredential.did;
    useVersion = pic.prevCredential.versionSequence;
  }
  return out.reverse();
}
