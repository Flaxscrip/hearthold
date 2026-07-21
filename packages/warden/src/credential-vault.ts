import {
  sealToKey,
  contentId,
  Sensitivity,
  type KeymasterHandle,
  type HearthholdConfig,
  type IssuedLeaf,
} from '@hearthold/core';

import { provisionMemberPartition } from './kb-config.js';
import { VaultStore, type Artefact } from './store.js';
import { IndexStore } from './index-store.js';
import { OllamaEmbedder } from './recall.js';

/** Render an issued credential's claims to a one-line, recallable summary (no signatures/keys). */
export function renderIssuedLeaf(leaf: IssuedLeaf): string {
  const fields = Object.entries(leaf.claims)
    .filter(([k]) => k !== 'type' && k !== 'id')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');
  return `${leaf.credentialType} credential from ${leaf.issuer}${fields ? ` — ${fields}` : ''} (issuer-attested)`;
}

/**
 * Bring an accepted third-party VC into the owner's PRIVATE member-key KB partition, so the fact it
 * asserts becomes recallable knowledge — while trust stays with the ISSUER.
 *
 * The rendered claim is sealed to the partition's PUBLIC key (`sealToKey`): the Warden write-hosts it
 * but CANNOT read it at rest; a read needs the owner's session-rewrapped key (the Phase-6 read-guest
 * path). The artefact carries `sealedTo:{partition}` and links back to the signed credential
 * (`credentialDid` + `issuer` + `schema` + `trustClass:'issued'`), so it can still be presented or
 * composed into an evidence graph as an `issued` leaf — the issuer's signature is never lost.
 *
 * So a 3rd-party VC the Sovereign holds becomes "my Hearthold privately knows this fact" — recallable to
 * the owner, opaque to the custodian at rest, and still provable with the issuer's own attestation.
 */
export async function ingestCredentialToPartition(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  args: { spaceId: string; ownerDid: string; leaf: IssuedLeaf; sensitivity?: Sensitivity },
): Promise<{ artefactId: string; partitionId: string; indexed: boolean }> {
  const partition = await provisionMemberPartition(handle, config, args.spaceId, args.ownerDid);
  if (!partition.partitionPub) {
    throw new Error('partition has no member key (a pre-family partition cannot write-host a private VC)');
  }

  const text = renderIssuedLeaf(args.leaf);
  const ciphertext = sealToKey(handle.cipher, partition.partitionPub, JSON.stringify({ text }));
  const id = contentId(ciphertext, handle.cipher);
  const now = new Date().toISOString();

  const artefact: Artefact = {
    id,
    kind: 'document',
    observedAt: args.leaf.acceptedAt ?? now,
    storedAt: now,
    sensitivity: args.sensitivity ?? Sensitivity.MEDIUM,
    ciphertext,
    sealedTo: { partition: partition.id }, // member-key: Warden write-hosts, cannot read at rest
    owner: args.ownerDid,
    scope: 'private',
    metadata: {
      kb: partition.id,
      // Link back to the signed credential so it stays presentable / composable as an `issued` leaf.
      credentialDid: args.leaf.credentialDid,
      issuer: args.leaf.issuer,
      credentialType: args.leaf.credentialType,
      schema: args.leaf.schema,
      trustClass: 'issued',
    },
  };
  await new VaultStore(handle.dataFolder).put(artefact);

  // Index for recall (embed) — only when the recall index is on. NON-SILENT: the caller learns via
  // `indexed:false` if the embedder is unavailable (the artefact is still stored + re-indexable).
  let indexed = false;
  if (config.indexMode === 'ollama') {
    try {
      const embedding = await new OllamaEmbedder(config.ollamaUrl, config.embeddingModel).embed(text);
      await new IndexStore(handle.dataFolder).put({
        artefactId: id,
        kind: 'document',
        observedAt: artefact.observedAt,
        sensitivity: artefact.sensitivity,
        embedding,
        kb: partition.id,
      });
      indexed = true;
    } catch {
      /* leave indexed:false — surfaced to the caller, re-indexable later */
    }
  }

  return { artefactId: id, partitionId: partition.id, indexed };
}
