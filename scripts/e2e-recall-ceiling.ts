/**
 * e2e: RECALL SENSITIVITY CEILING — recall/RAG must not summarize content above the caller's cleared tier.
 *
 * The gap (L2 audit): `rankByQuery`'s ceiling defaulted to Infinity and NO production caller set it, so a
 * bare session (or the public KB portal) could retrieve + summarize SEALED content with no step-up. The fix:
 * the control-plane recall derives its ceiling from the viewer's achieved tier (`clearanceCeiling`, default
 * STANDING→LOW; MEDIUM+ requires a real Signet step-up), and KB recall ceilings from its read assurance.
 *
 * This proves the composed invariant with the REAL `clearanceCeiling` + `rankByQuery`, isolating the ceiling
 * from similarity (every entry is equally similar, so ONLY the sensitivity ceiling decides what survives).
 *
 *   node --experimental-strip-types scripts/e2e-recall-ceiling.ts   (pure — no Archon node / Ollama needed)
 */
import { rankByQuery, clearanceCeiling, AuthzTier, Sensitivity, type IndexEntry } from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

// One artefact at each sensitivity; identical embeddings so similarity is constant and the ceiling is the
// only thing that filters (a SEALED note that is MAXIMALLY similar must still be dropped below its ceiling).
const V = [1, 0];
const entries: IndexEntry[] = ([
  ['pub', Sensitivity.PUBLIC],
  ['low', Sensitivity.LOW],
  ['med', Sensitivity.MEDIUM],
  ['high', Sensitivity.HIGH],
  ['sealed', Sensitivity.SEALED],
] as const).map(([id, s]) => ({ artefactId: id, kind: 'document', observedAt: '2026-07-27T00:00:00Z', sensitivity: s, embedding: V }) as IndexEntry);

const idsAt = (ceiling: Sensitivity): string[] => rankByQuery(V, entries, { k: 10, maxSensitivity: ceiling }).map((r) => r.entry.artefactId).sort();

async function main(): Promise<void> {
  step('clearanceCeiling maps each tier to the max sensitivity it may draw on');
  check('STANDING → LOW', clearanceCeiling(AuthzTier.STANDING) === Sensitivity.LOW);
  check('CHALLENGE → MEDIUM', clearanceCeiling(AuthzTier.CHALLENGE) === Sensitivity.MEDIUM);
  check('HUMAN → HIGH', clearanceCeiling(AuthzTier.HUMAN) === Sensitivity.HIGH);
  check('MULTIFACTOR → SEALED', clearanceCeiling(AuthzTier.MULTIFACTOR) === Sensitivity.SEALED);

  step('The DEFAULT recall (a bare session → STANDING ceiling) draws on ≤LOW only');
  check('STANDING ceiling returns exactly {pub, low} — MEDIUM/HIGH/SEALED excluded', JSON.stringify(idsAt(clearanceCeiling(AuthzTier.STANDING))) === JSON.stringify(['low', 'pub']));

  step('A SEALED note, even maximally similar, is dropped until the tier clears it');
  check('CHALLENGE ceiling: MEDIUM in, HIGH/SEALED out', JSON.stringify(idsAt(clearanceCeiling(AuthzTier.CHALLENGE))) === JSON.stringify(['low', 'med', 'pub']));
  check('HUMAN ceiling: HIGH in, SEALED out', JSON.stringify(idsAt(clearanceCeiling(AuthzTier.HUMAN))) === JSON.stringify(['high', 'low', 'med', 'pub']));
  check('only a MULTIFACTOR ceiling reaches SEALED', idsAt(clearanceCeiling(AuthzTier.MULTIFACTOR)).includes('sealed') && idsAt(clearanceCeiling(AuthzTier.HUMAN)).includes('sealed') === false);

  step('KB read-assurance ceiling (kb.ts): factor1 → ≤MEDIUM, factor2 → SEALED');
  const kbCeil = (req: 'factor1' | 'factor2') => (req === 'factor2' ? Sensitivity.SEALED : Sensitivity.MEDIUM);
  check('a factor1 KB read never surfaces HIGH/SEALED', !idsAt(kbCeil('factor1')).includes('sealed') && !idsAt(kbCeil('factor1')).includes('high'));
  check('a factor2 KB read may reach SEALED', idsAt(kbCeil('factor2')).includes('sealed'));

  process.stdout.write(
    failures === 0
      ? '\n✓ recall-ceiling: recall/RAG is ladder-gated — the default draws on ≤LOW; SEALED needs a real step-up\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-recall-ceiling: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
