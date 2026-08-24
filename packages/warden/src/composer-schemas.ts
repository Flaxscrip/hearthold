/**
 * Canonical composer-friendly credential schemas for the Table's Compose-a-card (Sevenfold finding 2).
 * Unlike the type-only authorization/delegation schemas, these are TITLED and carry real user fields, so the
 * composer has meaningful credentials to mint. Each declares `type` as a schema `const` (the credential's
 * identity) — `/api/issue` derives + injects it server-side, so a composer only fills the user fields.
 */
import type { KeymasterHandle } from '@hearthold/core';

export interface ComposerSchema {
  title: string;
  schema: Record<string, unknown>;
}

const DRAFT = 'http://json-schema.org/draft-07/schema#';

export const COMPOSER_SCHEMAS: ComposerSchema[] = [
  {
    title: 'Endorsement',
    schema: {
      $schema: DRAFT,
      title: 'Endorsement',
      type: 'object',
      properties: {
        type: { type: 'string', const: 'Endorsement' },
        skill: { type: 'string', description: 'the skill or quality endorsed' },
        statement: { type: 'string', description: 'a short endorsement statement' },
        level: { type: 'string', enum: ['familiar', 'proficient', 'expert'] },
      },
      required: ['type', 'skill'],
    },
  },
  {
    title: 'Membership',
    schema: {
      $schema: DRAFT,
      title: 'Membership',
      type: 'object',
      properties: {
        type: { type: 'string', const: 'Membership' },
        organization: { type: 'string', description: 'the organization or group' },
        role: { type: 'string' },
        tier: { type: 'string' },
        memberSince: { type: 'string', description: 'ISO 8601 date' },
      },
      required: ['type', 'organization'],
    },
  },
  {
    title: 'Ticket',
    schema: {
      $schema: DRAFT,
      title: 'Ticket',
      type: 'object',
      properties: {
        type: { type: 'string', const: 'Ticket' },
        event: { type: 'string', description: 'the event this ticket admits to' },
        seat: { type: 'string' },
        validFrom: { type: 'string', description: 'ISO 8601' },
        validUntil: { type: 'string', description: 'ISO 8601' },
      },
      required: ['type', 'event'],
    },
  },
];

/**
 * Register the composer schemas on this Warden's registry, idempotently: a title already present is left as
 * is (its existing DID is returned). Returns each schema's title, DID, and whether it was newly created.
 */
export async function registerComposerSchemas(
  handle: KeymasterHandle,
): Promise<Array<{ title: string; did: string; created: boolean }>> {
  const existingDids = await handle.keymaster.listSchemas().catch(() => [] as string[]);
  const byTitle = new Map<string, string>();
  for (const did of existingDids) {
    const s = (await handle.keymaster.getSchema(did).catch(() => null)) as { title?: string } | null;
    if (s?.title) byTitle.set(s.title, did);
  }
  const out: Array<{ title: string; did: string; created: boolean }> = [];
  for (const { title, schema } of COMPOSER_SCHEMAS) {
    const already = byTitle.get(title);
    if (already) {
      out.push({ title, did: already, created: false });
      continue;
    }
    const did = (await handle.keymaster.createSchema(schema)) as string;
    out.push({ title, did, created: true });
  }
  return out;
}
