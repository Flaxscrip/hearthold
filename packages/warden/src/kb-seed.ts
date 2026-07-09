/**
 * Demo data for a Knowledge Base — load a curated set, or reset a KB to empty.
 *
 * Every complex system deserves a "load the demo, look around, then reset and start your own journey"
 * path. `seedKb` loads a curated set of SHARED knowledge (Invariant I — never personal 7th Capital)
 * through the real contribution pipeline (seal → classify → store → index), so seeded cards behave
 * exactly like contributed ones. `resetKb` removes only that KB's artefacts + index entries, leaving
 * the identity, access groups, and governed policy intact.
 */

import { sealForWarden, contentId, type KeymasterHandle, type HearthholdConfig } from '@hearthold/core';

import { createClassifier } from './classifier.js';
import { VaultStore, type Artefact } from './store.js';
import { IndexStore } from './index-store.js';
import { OllamaEmbedder } from './recall.js';

export interface DemoFact {
  kind: string;
  text: string;
}

/** Curated demo sets — shared, public-facing knowledge that makes a fresh portal answer something. */
export const DEMO_SETS: Record<string, DemoFact[]> = {
  hearthold: [
    { kind: 'document', text: 'The 7th Capital is a Sovereign First Person’s accumulated personal history — the value that lives in what you’ve done, seen, and can prove. Hearthold makes it safely liquid.' },
    { kind: 'document', text: 'The Warden is the always-on home Keeper: a local-only AI that custodies the sealed vault, classifies data on-device, and mints proofs. It never transmits your data.' },
    { kind: 'document', text: 'The Witness (also called the Mage) is the world-facing companion: it captures local context and carries proofs to third parties. It holds minimal data and no deciding secret.' },
    { kind: 'document', text: 'The Sovereign is the First Person, held by the Signet app. The Signet co-signs sensitive disclosures with a graded proof-of-human, and governs the Warden’s policy.' },
    { kind: 'document', text: 'The Privacy Is Value Model (PVM) holds that privacy is not a cost but a form of capital: control over disclosure is what makes personal history valuable rather than merely exposed.' },
    { kind: 'document', text: 'A Knowledge Portal is a shared, authorized Knowledge Base a community queries and updates through a public Mage, while a private Warden holds the data — the guild brain, never a personal vault.' },
    { kind: 'document', text: 'Authentication uses challenge/response: the member signs a Warden-issued challenge with their own wallet. Keys never leave the wallet and never touch the portal.' },
    { kind: 'event', text: 'Hearthold’s Knowledge Portal first ran end-to-end just before midnight on July 7th, 2026 — its first stored fact was the record of its own birth.' },
  ],
};

export const DEFAULT_DEMO_SET = 'hearthold';

/** Load a demo set into `kbId`. Seeded cards are shared knowledge, contributor-stamped `demo`. */
export async function seedKb(
  warden: KeymasterHandle,
  config: HearthholdConfig,
  wardenDid: string,
  kbId: string,
  setName: string = DEFAULT_DEMO_SET,
): Promise<{ loaded: number; set: string }> {
  const facts = DEMO_SETS[setName];
  if (!facts) throw new Error(`unknown demo set "${setName}" (have: ${Object.keys(DEMO_SETS).join(', ')})`);
  const store = new VaultStore(warden.dataFolder);
  const index = new IndexStore(warden.dataFolder);
  const embedder = config.indexMode === 'ollama' ? new OllamaEmbedder(config.ollamaUrl, config.embeddingModel) : undefined;
  const classifier = createClassifier(config);

  let loaded = 0;
  for (const fact of facts) {
    const ciphertext = await sealForWarden(warden, wardenDid, JSON.stringify({ text: fact.text }));
    const classification = await classifier.classify({ kind: fact.kind, text: fact.text });
    const id = contentId(ciphertext, warden.cipher);
    const artefact: Artefact = {
      id,
      kind: fact.kind as Artefact['kind'],
      observedAt: new Date().toISOString(),
      storedAt: new Date().toISOString(),
      sensitivity: classification.sensitivity,
      ciphertext,
      metadata: { ...classification.metadata, kb: kbId, contributor: 'demo', demo: true },
    };
    await store.put(artefact);
    if (embedder) {
      try {
        const embedding = await embedder.embed(fact.text);
        await index.put({ artefactId: id, kind: artefact.kind, observedAt: artefact.observedAt, sensitivity: artefact.sensitivity, embedding, kb: kbId });
      } catch {
        /* index best-effort */
      }
    }
    loaded++;
  }
  return { loaded, set: setName };
}

/** Remove every artefact + index entry belonging to `kbId` (identity, groups, policy untouched). */
export async function resetKb(warden: KeymasterHandle, kbId: string): Promise<{ removed: number }> {
  const store = new VaultStore(warden.dataFolder);
  const ids = (await store.list()).filter((a) => a.metadata?.kb === kbId).map((a) => a.id);
  const removed = await store.remove(ids);
  await new IndexStore(warden.dataFolder).remove(ids);
  return { removed };
}
