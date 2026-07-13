/**
 * e2e: deterministic evidence salts (pure — no node/vault).
 *
 * assembleEvidence(..., { saltSeed }) must be byte-reproducible: same metas + same saltSeed → identical
 * merkle root, salts, and leaf hashes; different saltSeed → different salts; no saltSeed → random each
 * call. This is what makes the disclosure bundle byte-stable for the harness's Fiat–Shamir draw.
 *
 * Run:  npm run e2e:evidence-deterministic
 */
import { assembleEvidence, Sensitivity, type ArtefactMeta, type EvidenceClaimSpec } from '@hearthold/core';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

const metas: ArtefactMeta[] = Array.from({ length: 6 }, (_, i) => ({
  id: `art-${i}`,
  kind: 'location',
  observedAt: `2026-0${i + 1}-15T12:00:00Z`,
  sensitivity: Sensitivity.LOW,
  witnessedBy: 'self',
}));
const spec: EvidenceClaimSpec = { kind: 'location', from: '2026-01-01', to: '2026-06-30' };

function main(): void {
  const a = assembleEvidence(metas, spec, { saltSeed: 'reference' });
  const b = assembleEvidence(metas, spec, { saltSeed: 'reference' });
  const c = assembleEvidence(metas, spec, { saltSeed: 'other' });
  const r1 = assembleEvidence(metas, spec);
  const r2 = assembleEvidence(metas, spec);
  if (!a || !b || !c || !r1 || !r2) throw new Error('assembleEvidence returned null');

  assert(a.group.commitment.merkleRoot === b.group.commitment.merkleRoot, 'same saltSeed → identical merkle root');
  assert(JSON.stringify(a.leaves) === JSON.stringify(b.leaves), 'same saltSeed → identical salts + leaf hashes');
  assert(a.group.commitment.merkleRoot !== c.group.commitment.merkleRoot, 'different saltSeed → different merkle root');
  assert(r1.group.commitment.merkleRoot !== r2.group.commitment.merkleRoot, 'no saltSeed → random salts (production default unchanged)');
  // Salt length is unchanged (32 hex = 16 bytes) → the byte count is unaffected by the mode.
  assert(a.leaves.every((l) => l.salt.length === 32) && r1.leaves.every((l) => l.salt.length === 32), 'salts are 32 hex chars in both modes (byte count unaffected)');

  process.stdout.write('\n✓ deterministic evidence salts: reproducible under saltSeed, random by default\n');
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`e2e-evidence-deterministic: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
