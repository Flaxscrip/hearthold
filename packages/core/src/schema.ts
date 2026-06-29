import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KeymasterHandle } from './keymaster.js';
import { CredentialType } from './credentials.js';

/**
 * JSON Schema for the HearthholdDelegation credential. The Warden registers this as an Archon
 * schema asset (a did:cid); the schema DID is what challenge/response matches against, so both
 * agents must reference the same registered schema.
 */
export const DELEGATION_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: CredentialType.DELEGATION,
  type: 'object',
  properties: {
    type: { type: 'string', const: CredentialType.DELEGATION },
    kinds: { type: 'array', items: { type: 'string' } },
  },
  required: ['type'],
  additionalProperties: true,
} as const;

interface SchemaRegistryFile {
  delegationSchemaDid?: string;
  /** name → schema DID, for issuer-registered credential schemas. */
  schemas?: Record<string, string>;
}

/** A permissive schema for a credential type: requires a `type` field, allows any other claims. */
export function openSchema(type: string): unknown {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: type,
    type: 'object',
    properties: { type: { type: 'string' } },
    required: ['type'],
    additionalProperties: true,
  };
}

/**
 * Ensure a named schema is registered, returning its DID. Idempotent and persisted in the handle's
 * data folder, so the same name reuses the same schema DID (which a verifier can rely on per type).
 */
export async function ensureSchema(
  handle: KeymasterHandle,
  name: string,
  schema: unknown,
): Promise<string> {
  const reg = await readRegistry(handle.dataFolder);
  const existing = reg.schemas?.[name];
  if (existing) {
    const ok = await handle.keymaster.getSchema(existing).then((s) => s != null, () => false);
    if (ok) return existing;
  }
  const schemaDid = await handle.keymaster.createSchema(schema);
  await writeRegistry(handle.dataFolder, {
    ...reg,
    schemas: { ...(reg.schemas ?? {}), [name]: schemaDid },
  });
  return schemaDid;
}

function registryPath(dataFolder: string): string {
  return join(dataFolder, 'hearthold-schemas.json');
}

async function readRegistry(dataFolder: string): Promise<SchemaRegistryFile> {
  try {
    return JSON.parse(await readFile(registryPath(dataFolder), 'utf8')) as SchemaRegistryFile;
  } catch {
    return {};
  }
}

async function writeRegistry(dataFolder: string, data: SchemaRegistryFile): Promise<void> {
  await mkdir(dataFolder, { recursive: true });
  await writeFile(registryPath(dataFolder), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Ensure the delegation schema is registered, returning its DID. Idempotent: the schema DID is
 * persisted in the Warden's data folder and reused across runs. The Warden must be the current
 * identity on the handle.
 */
export async function ensureDelegationSchema(warden: KeymasterHandle): Promise<string> {
  const reg = await readRegistry(warden.dataFolder);
  if (reg.delegationSchemaDid) {
    // Confirm it still resolves; if not, fall through and re-create.
    const ok = await warden.keymaster.getSchema(reg.delegationSchemaDid).then(
      (s) => s != null,
      () => false,
    );
    if (ok) return reg.delegationSchemaDid;
  }

  const schemaDid = await warden.keymaster.createSchema(DELEGATION_SCHEMA);
  await writeRegistry(warden.dataFolder, { ...reg, delegationSchemaDid: schemaDid });
  return schemaDid;
}
