/**
 * Triage — the born-obsidian confirmation queue for the Sevenfold Table.
 *
 * Anything the classifier was unsure about (or that would relax below the human-confirm threshold) is
 * stored flagged `needsHumanConfirmation`. The Table renders these fully obsidian (G1); the Sovereign
 * confirms the Scribe's proposed sensitivity or overrides it — and confirming clears the flag. The act
 * of confirming through this endpoint IS the human confirmation the security model requires for
 * relaxing below `HUMAN_CONFIRM_BELOW`.
 */

import { relaxNeedsConfirmation, type Sensitivity, type KeymasterHandle } from '@hearthold/core';

import { VaultStore, type Artefact } from './store.js';
import type { TriageItem } from '@hearthold/control-types';

const SENSITIVITY_NAMES = ['PUBLIC', 'LOW', 'MEDIUM', 'HIGH', 'SEALED'] as const;
const sName = (s: number): (typeof SENSITIVITY_NAMES)[number] => SENSITIVITY_NAMES[s] ?? 'SEALED';

/** Artefacts awaiting the Sovereign's confirmation (metadata carries the flag + the Scribe's proposal). */
export async function triageQueue(
  warden: KeymasterHandle,
  visible: (a: Artefact) => boolean = () => true,
): Promise<TriageItem[]> {
  const items = await new VaultStore(warden.dataFolder).list();
  return items
    .filter((a) => a.metadata?.needsHumanConfirmation === true && visible(a))
    .map((a) => ({
      artefactId: a.id,
      kind: a.kind,
      observedAt: a.observedAt,
      proposedSensitivity: a.sensitivity,
      proposedSensitivityName: sName(a.sensitivity),
      tags: (a.metadata?.tags as string[] | undefined) ?? [],
      reason: (a.metadata?.reason as string | undefined) ?? '',
    }));
}

/**
 * Confirm a quarantined artefact at `sensitivity` (accept the proposal or override), clearing the flag.
 * `sensitivity` is the Sovereign's explicit choice — that human gesture is exactly the confirmation the
 * model requires to relax below the threshold, so overriding *down* is permitted here.
 */
export async function confirmTriage(
  warden: KeymasterHandle,
  args: { artefactId: string; sensitivity: Sensitivity },
): Promise<TriageItem> {
  const store = new VaultStore(warden.dataFolder);
  const a = await store.get(args.artefactId);
  if (!a) throw new Error(`no such artefact ${args.artefactId}`);
  const updated = {
    ...a,
    sensitivity: args.sensitivity,
    metadata: {
      ...a.metadata,
      needsHumanConfirmation: false,
      // Record that a human set it, and whether it was a relax-below-threshold decision.
      confirmedBySovereign: true,
      relaxedBelowThreshold: relaxNeedsConfirmation(args.sensitivity),
    },
  };
  await store.put(updated);
  return {
    artefactId: a.id,
    kind: a.kind,
    observedAt: a.observedAt,
    proposedSensitivity: args.sensitivity,
    proposedSensitivityName: sName(args.sensitivity),
    tags: (a.metadata?.tags as string[] | undefined) ?? [],
    reason: (a.metadata?.reason as string | undefined) ?? '',
  };
}
