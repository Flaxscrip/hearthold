/**
 * Card-face hydration — the Warden's local render surface for the Sevenfold Table.
 *
 * The Table shows the Sovereign their own vault as cards. To render a card's *face* (its real content)
 * the Warden must unseal it — so every hydration crosses the release decision (`decideRelease`) with a
 * `LOCAL_RENDER` disclosure, gated by the sensitivity/tier ladder. A refusal is a first-class outcome
 * (the Table draws obsidian), never an exception.
 *
 * Faithful to recall's unseal-at-use: the plaintext is decrypted to memory for the one response and
 * never written to disk outside the vault, never cached (G2). This is the home-plane control API only;
 * a remote (DIDComm) render path is deliberately out of scope for P1.
 */

import {
  unsealAsWarden,
  decideRelease,
  DisclosureMode,
  Sensitivity,
  type AuthzTier,
  type KeymasterHandle,
} from '@hearthold/core';

import { VaultStore } from './store.js';
import type { CardFace } from '@hearthold/control-types';

const SENSITIVITY_NAMES = ['PUBLIC', 'LOW', 'MEDIUM', 'HIGH', 'SEALED'] as const;
type SensitivityName = (typeof SENSITIVITY_NAMES)[number];
const sensitivityName = (s: number): SensitivityName => SENSITIVITY_NAMES[s] ?? 'SEALED';

/**
 * Hydrate one card's face at the tier the session has satisfied. Throws only on a *real* failure
 * (unknown artefact, unseal error); a ladder refusal returns `{ granted: false }` for the UI to render
 * obsidian.
 */
export async function hydrateCardFace(
  warden: KeymasterHandle,
  args: { artefactId: string; tier: AuthzTier },
): Promise<CardFace> {
  const artefact = await new VaultStore(warden.dataFolder).get(args.artefactId);
  if (!artefact) throw new Error(`no such artefact ${args.artefactId}`);

  const sensitivity = artefact.sensitivity as Sensitivity;
  const base = { artefactId: args.artefactId, sensitivity, sensitivityName: sensitivityName(sensitivity) };

  // Every render crosses the release decision. The Sovereign is the principal at home (no delegation),
  // so the gate is the TIER — proof-of-presence scaling with sensitivity (SEALED ⇒ MULTIFACTOR).
  const decision = decideRelease({
    sensitivity,
    tier: args.tier,
    delegationValid: true,
    mode: DisclosureMode.LOCAL_RENDER,
    disclosureSatisfiable: true,
  });
  if (!decision.allow) {
    return { ...base, granted: false, reason: decision.reason };
  }

  // Transient unseal, exactly like recall — plaintext lives only for this response.
  const plain = await unsealAsWarden(warden, artefact.ciphertext);
  let face = plain;
  try {
    // Submissions seal JSON `{text}`; render the text. Anything else renders raw.
    face = (JSON.parse(plain) as { text?: string }).text ?? plain;
  } catch {
    /* raw */
  }
  const mimeType = (artefact.metadata?.mimeType as string | undefined) ?? 'text/plain';
  return { ...base, granted: true, face: Buffer.from(face, 'utf8').toString('base64'), mimeType };
}
