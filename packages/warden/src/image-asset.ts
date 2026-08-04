/**
 * Resolve an image submission's sealed payload to renderable bytes.
 *
 * An image artefact's ciphertext is an asset REFERENCE, not renderable content. The payload is one of:
 *   - `{ assetDid }` — a native Archon image asset (bytes in the node's IPFS); `getImage` it back. PREFERRED.
 *   - `{ image | attachment: { bytesB64, mediaType? } }` — inline base64 (a direct/test submission).
 *
 * Shared by the ingestion captioner (`service.ts`) and card-face hydration (`face.ts`): a keyless browser
 * holds no wallet and reaches no IPFS, so ONLY the custodian can turn `assetDid` → bytes (decision #4).
 * Returns base64 + media type (+ the asset DID for provenance), or null on ANY failure (bad payload,
 * unresolvable asset) so callers fail CLOSED — a missing image quarantines/obsidians, never leaks.
 */

import type { KeymasterHandle } from '@hearthold/core';

export interface ResolvedImage {
  bytesB64: string;
  mediaType?: string;
  assetDid?: string;
}

export async function resolveImageBytes(
  warden: KeymasterHandle,
  plaintext: string,
): Promise<ResolvedImage | null> {
  let payload: { assetDid?: string; image?: { bytesB64?: string; mediaType?: string }; attachment?: { bytesB64?: string; mediaType?: string } };
  try {
    payload = JSON.parse(plaintext) as typeof payload;
  } catch {
    return null;
  }
  if (payload.assetDid) {
    const asset = await warden.keymaster.getImage(payload.assetDid).catch(() => null);
    const data = asset?.file?.data;
    if (!data) return null; // unresolvable asset → fail closed
    return { bytesB64: Buffer.from(data).toString('base64'), mediaType: asset.file.type, assetDid: payload.assetDid };
  }
  const inline = payload.image ?? payload.attachment;
  if (inline?.bytesB64) return { bytesB64: inline.bytesB64, mediaType: inline.mediaType };
  return null;
}
