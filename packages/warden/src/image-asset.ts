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

import { Jimp } from 'jimp';

import type { KeymasterHandle } from '@hearthold/core';

export interface ResolvedImage {
  bytesB64: string;
  mediaType?: string;
  assetDid?: string;
}

/** Longest-edge px for a card-face thumbnail. A face is a preview; full-res is a deliberate open/reveal. */
const DEFAULT_THUMB_PX = 256;
/** jimp can ENCODE these; a webp/other input is decoded then thumbed to png. */
const ENCODABLE = new Set(['image/jpeg', 'image/png', 'image/bmp', 'image/gif', 'image/tiff']);

/**
 * Downscale resolved image bytes to a ~256px longest-edge THUMBNAIL for the card face, so a spread that
 * hydrates every ≤LOW image face at once stays light. Preserves aspect ratio; only scales DOWN (a small
 * image is returned untouched — no re-encode). Re-encodes to the same format when jimp can, else PNG. Pure-JS
 * (jimp — no native deps, Pi-safe). On ANY decode/encode failure, returns the FULL bytes (graceful — the fix
 * is "bytes render"; the thumbnail is an optimization, never a failure mode).
 */
export async function thumbnailImage(
  bytesB64: string,
  mediaType: string | undefined,
  maxEdge = DEFAULT_THUMB_PX,
): Promise<{ bytesB64: string; mediaType: string }> {
  const inputMime = mediaType && mediaType.startsWith('image/') ? mediaType : 'image/png';
  try {
    const img = await Jimp.read(Buffer.from(bytesB64, 'base64'));
    if (img.width <= maxEdge && img.height <= maxEdge) {
      return { bytesB64, mediaType: inputMime }; // already ≤ a thumbnail — serve as-is (no re-encode cost)
    }
    img.scaleToFit({ w: maxEdge, h: maxEdge });
    const outMime = ENCODABLE.has(inputMime) ? inputMime : 'image/png';
    const out = await img.getBuffer(outMime as 'image/png');
    return { bytesB64: Buffer.from(out).toString('base64'), mediaType: outMime };
  } catch {
    return { bytesB64, mediaType: inputMime }; // unsupported/corrupt → full-res still renders
  }
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
