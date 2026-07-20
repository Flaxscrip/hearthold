import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  GroupTrustRegistry,
  RulesetAssurancePolicy,
  createRegistryGroup,
  grantAuthorization,
  rulesetId,
  activeRuleset,
  selfSigner,
  Sensitivity,
  generatePartitionKeypair,
  wrapKeyForDid,
  type KeymasterHandle,
  type HearthholdConfig,
  type Ruleset,
  type SignedRuleset,
  type RulesetSigner,
  type AssuranceTier,
} from '@hearthold/core';

import { KbService, type KbActionApprover } from './kb.js';
import { PartitionStore, partitionIdFor, type PartitionRecord } from './partition-store.js';
import { SessionKeyStore } from './session-keys.js';
import type { RewrapChannel } from './rewrap.js';

/**
 * Persisted KB provisioning for a Warden: the resource (a KB *space*), its shared-partition access
 * groups, and its policy chain. A space with `memberPartitions` auto-provisions a private partition per
 * granted member (docs/kb-spaces.md).
 */
export interface KbConfig {
  kbId: string;
  readGroup: string;
  writeGroup: string;
  /** Ledger asset holding the Sovereign-signed assurance Ruleset chain (governance policy). */
  policyAsset?: string;
  /** The governing DID that signs the policy chain (readers pin it). Absent = self-governed by Warden. */
  governorDid?: string;
  /** KB Spaces: grant a member their own private partition (private DB) on join. Default false. */
  memberPartitions?: boolean;
  /** Where a scope-less contribution lands. Default 'shared'. Personal-profile spaces set 'private'. */
  defaultScope?: 'shared' | 'private';
}

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Provision a member's private partition in a space: a single GroupTrustRegistry group whose sole member
 * is the owner (read + write), recorded (location `local`) so recall can add it to the owner's visible
 * set. Idempotent — returns the existing record if already provisioned.
 */
export async function provisionMemberPartition(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  spaceId: string,
  ownerDid: string,
): Promise<PartitionRecord> {
  const partitions = new PartitionStore(handle.dataFolder);
  const existing = await partitions.get(spaceId, ownerDid);
  if (existing) return existing;
  const id = partitionIdFor(spaceId, ownerDid);
  const group = await createRegistryGroup(handle, `kb-priv-${sha16(spaceId + ownerDid)}`, config.registry);
  await grantAuthorization(handle, group, ownerDid);
  // Member-key encryption (threat-model §0): mint a partition keypair; the Warden keeps the public half
  // (seals private content, write-host) and stores the private half wrapped to the member (read-guest —
  // it cannot open this at rest). The live seal/read cutover to this key rides Phase 2's session rewrap.
  const kp = generatePartitionKeypair(handle.cipher);
  const wrappedKey = await wrapKeyForDid(handle, ownerDid, kp.privateJwk);
  const rec: PartitionRecord = {
    spaceId,
    owner: ownerDid,
    id,
    group,
    location: { kind: 'local' },
    createdAt: new Date().toISOString(),
    partitionPub: kp.publicJwk,
    wrappedKey,
  };
  await partitions.put(rec);
  return rec;
}

/**
 * Retrofit KB Spaces onto an already-provisioned KB: flip `memberPartitions` on, set the default
 * contribution scope, and backfill a private partition for every current member (read ∪ write) — the same
 * set `kb-grant` provisions for, so a member granted before spaces were enabled is not left without one.
 * Non-destructive and idempotent: existing shared content is untouched, `provisionMemberPartition` returns
 * the existing record for members who already have one, and re-running only reaffirms. Returns whether
 * spaces were already on and the member DIDs that now hold a partition.
 */
export async function enableMemberPartitions(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  store: KbConfigStore,
  kb: KbConfig,
  defaultScope?: 'shared' | 'private',
): Promise<{ alreadyOn: boolean; members: string[] }> {
  const alreadyOn = kb.memberPartitions === true;
  await store.put({ ...kb, memberPartitions: true, defaultScope: defaultScope ?? kb.defaultScope });
  const membersOf = async (group: string): Promise<string[]> => {
    const g = (await handle.keymaster.getGroup(group).catch(() => null)) as { members?: string[] } | null;
    return g?.members ?? [];
  };
  const members = Array.from(new Set([...(await membersOf(kb.readGroup)), ...(await membersOf(kb.writeGroup))]));
  for (const did of members) await provisionMemberPartition(handle, config, kb.kbId, did);
  return { alreadyOn, members };
}

/** Raised when governance (the Signet) declines / is unreachable — the caller must not proceed. */
export class GovernanceDeclined extends Error {
  constructor(what: string) {
    super(`governance declined: ${what} was not signed by the Sovereign`);
  }
}

/**
 * Provision the KB's assurance policy as a signed genesis Ruleset chain (default: everything factor1).
 * `signer` decides who governs: `selfSigner` (Warden self-governs) or a DIDComm signer routing to the
 * Sovereign's Signet. The chain is signed by `signer.governor`; readers pin it. Returns the chain asset.
 */
export async function initKbAssurance(handle: KeymasterHandle, config: HearthholdConfig, kbId: string, signer: RulesetSigner): Promise<string> {
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
  const signed = await signer.sign(genesis, `establish the assurance policy for "${kbId}" (read→factor1, write→factor1)`);
  if (!signed) throw new GovernanceDeclined(`the "${kbId}" genesis policy`);
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
  signer: RulesetSigner,
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
  const signed = await signer.sign(next, `set assurance for "${action}" on "${kbId}" to ${tier}`);
  if (!signed) throw new GovernanceDeclined(`the "${kbId}" policy change (${action}→${tier})`);
  return handle.keymaster.createAsset([...chain, signed], { registry: config.registry });
}

/** Read the current assurance tiers from a policy chain (for display). Verified + governor-pinned. */
export async function readKbAssurance(handle: KeymasterHandle, chainAsset?: string, governorDid?: string): Promise<{ read: string; write: string }> {
  const data = chainAsset ? await handle.keymaster.resolveAsset(chainAsset).catch(() => null) : null;
  const chain = (Array.isArray(data) ? data : []) as SignedRuleset[];
  const head = chain.length ? await activeRuleset(handle, chain, { expectedSigner: governorDid }) : null;
  const a = head?.capabilities.assurance ?? {};
  return { read: a.read ?? 'factor1', write: a.write ?? 'factor1' };
}

/**
 * File-backed store of the Warden's Knowledge Bases, keyed by `kbId`. One Warden identity custodies
 * many KBs (a password DB, a guild KB, a docs KB, …), each a resource with its own groups + governed
 * policy. Migrates transparently from the old single-config shape.
 */
export class KbConfigStore {
  private readonly file: string;

  constructor(private readonly dataFolder: string) {
    this.file = join(dataFolder, 'hearthold-kb.json');
  }

  private async all(): Promise<Record<string, KbConfig>> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
      // Migrate the legacy single-config shape ({ kbId, readGroup, ... }) → a { [kbId]: config } map.
      if (typeof raw.kbId === 'string') {
        const cfg = raw as unknown as KbConfig;
        return { [cfg.kbId]: cfg };
      }
      return raw as Record<string, KbConfig>;
    } catch {
      return {};
    }
  }

  /** All provisioned KBs. */
  async list(): Promise<KbConfig[]> {
    return Object.values(await this.all());
  }

  /** One KB by id, or the sole KB when `kbId` is omitted and exactly one exists (CLI convenience). */
  async get(kbId?: string): Promise<KbConfig | null> {
    const all = await this.all();
    if (kbId) return all[kbId] ?? null;
    const only = Object.values(all);
    return only.length === 1 ? (only[0] as KbConfig) : null;
  }

  /** Add or replace a KB config. */
  async put(config: KbConfig): Promise<void> {
    const all = await this.all();
    all[config.kbId] = config;
    await mkdir(this.dataFolder, { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
}

/** Build a live `KbService` from one KB config. */
function serviceFor(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  wardenDid: string,
  kb: KbConfig,
  approver?: KbActionApprover,
  readGuest?: { sessionKeys: SessionKeyStore; rewrapChannel: RewrapChannel },
): KbService {
  // Governance policy (required assurance per action) is a Sovereign-signed Ruleset chain on the
  // ledger; the Warden reads + verifies it, PINNED to the governing DID (fail-closed on tamper or a
  // forged self-signature — a compromised Warden cannot rewrite policy it doesn't govern).
  const policy = kb.policyAsset ? new RulesetAssurancePolicy(handle, kb.policyAsset, kb.governorDid) : undefined;
  const registry = new GroupTrustRegistry(
    handle,
    [
      { action: 'read', resource: kb.kbId, group: kb.readGroup },
      { action: 'write', resource: kb.kbId, group: kb.writeGroup },
    ],
    wardenDid,
    policy,
  );
  return new KbService(handle, config, {
    kbId: kb.kbId,
    wardenDid,
    registry,
    approver,
    memberPartitions: kb.memberPartitions,
    defaultScope: kb.defaultScope,
    partitions: kb.memberPartitions ? new PartitionStore(handle.dataFolder) : undefined,
    sessionKeys: readGuest?.sessionKeys,
    rewrapChannel: readGuest?.rewrapChannel,
  });
}

/**
 * Build every provisioned KB's `KbService`, keyed by `kbId`. The daemon routes an incoming request to
 * the service matching its `kbId`. Empty map when no KB is provisioned.
 */
export async function buildKbServices(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  wardenDid: string,
  approver?: KbActionApprover,
  rewrapChannel?: RewrapChannel,
): Promise<Map<string, KbService>> {
  const kbs = await new KbConfigStore(handle.dataFolder).list();
  // One read-guest key store shared across this Warden's KB services (tokens are unique per login, so the
  // (token, partition) keying never collides). Present only when a rewrap channel is wired — the Phase-6
  // member-key read path; without it, KB reads use the pre-cutover Warden-sealed path.
  const readGuest = rewrapChannel ? { sessionKeys: new SessionKeyStore(), rewrapChannel } : undefined;
  return new Map(kbs.map((kb) => [kb.kbId, serviceFor(handle, config, wardenDid, kb, approver, readGuest)]));
}
