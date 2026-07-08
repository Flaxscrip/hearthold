import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  GroupTrustRegistry,
  RulesetAssurancePolicy,
  signRuleset,
  rulesetId,
  activeRuleset,
  Sensitivity,
  type KeymasterHandle,
  type HearthholdConfig,
  type Ruleset,
  type SignedRuleset,
  type AssuranceTier,
} from '@hearthold/core';

import { KbService, type KbActionApprover } from './kb.js';

/** Persisted KB provisioning for a Warden: the resource, its access groups, and its policy chain. */
export interface KbConfig {
  kbId: string;
  readGroup: string;
  writeGroup: string;
  /** Ledger asset holding the Sovereign-signed assurance Ruleset chain (governance policy). */
  policyAsset?: string;
}

/**
 * Provision the KB's assurance policy as a signed genesis Ruleset chain (default: everything factor1).
 * Signed by `handle` — the KB's governing authority (self-governed by the KB Warden in this increment;
 * a separate governing Sovereign is the natural hardening). Returns the chain asset DID.
 */
export async function initKbAssurance(handle: KeymasterHandle, config: HearthholdConfig, kbId: string): Promise<string> {
  const genesis: Ruleset = {
    actor: kbId,
    actorKind: 'kb',
    resource: kbId,
    version: 1,
    previous: null,
    capabilities: { assurance: { read: 'factor1', write: 'factor1' } },
    ceiling: Sensitivity.SEALED,
    status: 'active',
  };
  const signed = await signRuleset(handle, genesis);
  return handle.keymaster.createAsset([signed], { registry: config.registry });
}

/** Append a signed version raising/lowering the assurance for one action; re-anchor the chain. */
export async function setKbAssurance(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  kbId: string,
  currentChain: string | undefined,
  action: string,
  tier: AssuranceTier,
): Promise<string> {
  const data = currentChain ? await handle.keymaster.resolveAsset(currentChain).catch(() => null) : null;
  const chain = (Array.isArray(data) ? data : []) as SignedRuleset[];
  const prev = chain.length ? (chain[chain.length - 1] as SignedRuleset) : null;
  const next: Ruleset = {
    actor: kbId,
    actorKind: 'kb',
    resource: kbId,
    version: (prev?.version ?? 0) + 1,
    previous: prev ? rulesetId(prev) : null,
    capabilities: { assurance: { ...(prev?.capabilities.assurance ?? {}), [action]: tier } },
    ceiling: Sensitivity.SEALED,
    status: 'active',
  };
  const signed = await signRuleset(handle, next);
  return handle.keymaster.createAsset([...chain, signed], { registry: config.registry });
}

/** Read the current assurance tiers from a policy chain (for display). Verified via the active head. */
export async function readKbAssurance(handle: KeymasterHandle, chainAsset?: string): Promise<{ read: string; write: string }> {
  const data = chainAsset ? await handle.keymaster.resolveAsset(chainAsset).catch(() => null) : null;
  const chain = (Array.isArray(data) ? data : []) as SignedRuleset[];
  const head = chain.length ? await activeRuleset(handle, chain) : null;
  const a = head?.capabilities.assurance ?? {};
  return { read: a.read ?? 'factor1', write: a.write ?? 'factor1' };
}

/**
 * File-backed KB config in the Warden's data folder. One KB per Warden in this increment (the
 * Warden's vault *is* the KB), so this holds a single config.
 */
export class KbConfigStore {
  private readonly file: string;

  constructor(private readonly dataFolder: string) {
    this.file = join(dataFolder, 'hearthold-kb.json');
  }

  async read(): Promise<KbConfig | null> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as KbConfig;
    } catch {
      return null;
    }
  }

  async save(config: KbConfig): Promise<void> {
    await mkdir(this.dataFolder, { recursive: true });
    await writeFile(this.file, JSON.stringify(config, null, 2), 'utf8');
  }
}

/**
 * Build a live `KbService` from the Warden's persisted KB config, or undefined if no KB is provisioned.
 * Used by the daemon (`serve` / `control`) to serve the KB over DIDComm.
 */
export async function buildKbService(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  wardenDid: string,
  approver?: KbActionApprover,
): Promise<KbService | undefined> {
  const kb = await new KbConfigStore(handle.dataFolder).read();
  if (!kb) return undefined;
  // Governance policy (required assurance per action) is a Sovereign-signed Ruleset chain on the
  // ledger; the Warden reads + verifies it (fail-closed on tamper).
  const policy = kb.policyAsset ? new RulesetAssurancePolicy(handle, kb.policyAsset) : undefined;
  const registry = new GroupTrustRegistry(
    handle,
    [
      { action: 'read', resource: kb.kbId, group: kb.readGroup },
      { action: 'write', resource: kb.kbId, group: kb.writeGroup },
    ],
    wardenDid,
    policy,
  );
  return new KbService(handle, config, { kbId: kb.kbId, wardenDid, registry, approver });
}
