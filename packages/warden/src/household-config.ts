import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A household — a governed space over the shared Archon Vault + per-member private partitions. One Warden
 * custodies it; one Master-Sovereign (`governorDid`) governs it. The shared partition's Ruleset, the
 * roster (read group), and the contributor roster (write group) are all the existing KB-space primitives,
 * re-used here so the family model rides proven, governor-pinned machinery.
 */
export interface HouseholdConfig {
  householdId: string;
  /** The shared partition — a Warden-owned Archon Vault DID (`household-vault.ts`). */
  sharedVaultDid: string;
  /** The Master-Sovereign: governs membership + the shared Ruleset (same semantics as `KbConfig.governorDid`). */
  governorDid: string;
  /** Signed Ruleset chain: shared-partition assurance + contributor tiers + roster amendments (Phase 4). */
  policyAsset?: string;
  /** Household roster (read group) — members with shared read + a private partition. */
  readGroup: string;
  /** Contributor roster (write group) — members permitted to write shared content. */
  writeGroup: string;
  /** A household always provisions per-member private partitions. */
  memberPartitions: true;
  /**
   * Governor activity-observation (SSE metadata only): when true, `submission-stored`-class events reach
   * the governor. Default FALSE — privacy-first isolation by default (flaxscrip decision). NB: this is
   * metadata only; governor access to member DATA is never this bit — it is per-edge Guardianship
   * Rulesets (guardianship-threat-model.md), Phase 5.
   */
  governorObservesActivity: boolean;
}

/**
 * File-backed store of the Warden's households, keyed by `householdId`. Mirrors `KbConfigStore`; most
 * Wardens hold exactly one household, so `get()` returns the sole one when the id is omitted.
 */
export class HouseholdConfigStore {
  private readonly file: string;

  constructor(private readonly dataFolder: string) {
    this.file = join(dataFolder, 'hearthold-households.json');
  }

  private async all(): Promise<Record<string, HouseholdConfig>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, HouseholdConfig>;
    } catch {
      return {};
    }
  }

  /** All provisioned households. */
  async list(): Promise<HouseholdConfig[]> {
    return Object.values(await this.all());
  }

  /** One household by id, or the sole household when `householdId` is omitted and exactly one exists. */
  async get(householdId?: string): Promise<HouseholdConfig | null> {
    const all = await this.all();
    if (householdId) return all[householdId] ?? null;
    const only = Object.values(all);
    return only.length === 1 ? (only[0] as HouseholdConfig) : null;
  }

  /** Add or replace a household config. */
  async put(config: HouseholdConfig): Promise<void> {
    const all = await this.all();
    all[config.householdId] = config;
    await mkdir(this.dataFolder, { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
}
