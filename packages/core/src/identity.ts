import type { KeymasterHandle } from './keymaster.js';
import type { HearthholdConfig } from './config.js';

/** Canonical wallet alias for each agent's identity. */
export const IDENTITY_NAME = {
  warden: 'hearthold-warden',
  emissary: 'hearthold-emissary',
  sovereign: 'hearthold-sovereign',
  verifier: 'hearthold-verifier',
  registry: 'hearthold-registry',
} as const;

export interface AgentIdentity {
  name: string;
  did: string;
}

/**
 * Ensure the agent's identity exists and is current, creating the wallet and DID on first run.
 * Idempotent: returns the existing identity if already provisioned.
 */
export async function ensureIdentity(
  handle: KeymasterHandle,
  config: HearthholdConfig,
): Promise<AgentIdentity> {
  const { keymaster } = handle;
  const name = IDENTITY_NAME[handle.role];

  // listIds() auto-creates a fresh wallet on first use; do NOT call newWallet() ourselves —
  // a second newWallet() poisons the in-memory HD key cache and desyncs seed from `enc`.
  const existing = await keymaster.listIds();
  if (!existing.includes(name)) {
    await keymaster.createId(name, { registry: config.registry });
  }

  await keymaster.setCurrentId(name);
  const did = await keymaster.resolveDID(name).then((doc) => doc.didDocument?.id ?? '');
  return { name, did };
}

/** Resolve the current agent identity without mutating the wallet. */
export async function currentIdentity(handle: KeymasterHandle): Promise<AgentIdentity | null> {
  const name = await handle.keymaster.getCurrentId();
  if (!name) return null;
  const did = await handle.keymaster.resolveDID(name).then((doc) => doc.didDocument?.id ?? '');
  return { name, did };
}
