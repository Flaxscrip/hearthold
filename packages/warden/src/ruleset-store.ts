import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  signRuleset,
  rulesetId,
  authorizeActor,
  type KeymasterHandle,
  type HearthholdConfig,
  type Ruleset,
  type SignedRuleset,
  type ActorRequest,
  type ActorAuthz,
} from '@hearthold/core';

/**
 * The Warden's store of contained actors' Ruleset chains — the persistence + enforcement surface a
 * cantrip runtime (Sevenfold, P3) plugs into. Each actor's signed chain is anchored on the ledger (an
 * asset holding `SignedRuleset[]`, auditable like the KB assurance policy); this file-backed index maps
 * `actor → chain asset`. The Warden signs each version (self-governed default; a governing Sovereign is
 * the natural hardening) and, on every actor-originated request, checks it against the active Ruleset —
 * so a cantrip's ceiling is Warden-enforced at egress, not self-declared.
 */
export class RulesetStore {
  private readonly file: string;

  constructor(
    private readonly handle: KeymasterHandle,
    private readonly config: HearthholdConfig,
  ) {
    this.file = join(handle.dataFolder, 'rulesets.json');
  }

  private async index(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async setIndex(actor: string, asset: string): Promise<void> {
    const idx = await this.index();
    idx[actor] = asset;
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify(idx, null, 2), 'utf8');
  }

  /** Register a new actor with a signed genesis Ruleset. */
  async register(ruleset: Omit<Ruleset, 'version' | 'previous'>): Promise<void> {
    const genesis: Ruleset = { ...ruleset, version: 1, previous: null };
    const signed = await signRuleset(this.handle, genesis);
    const asset = await this.handle.keymaster.createAsset([signed], { registry: this.config.registry });
    await this.setIndex(ruleset.actor, asset);
  }

  /** Append a signed version to an actor's chain (supersede its capabilities, or revoke it). */
  async append(actor: string, next: Pick<Ruleset, 'capabilities' | 'ceiling' | 'status'>): Promise<void> {
    const chain = await this.load(actor);
    const prev = chain.length ? (chain[chain.length - 1] as SignedRuleset) : null;
    if (!prev) throw new Error(`no Ruleset registered for ${actor}`);
    const ruleset: Ruleset = {
      actor,
      actorKind: prev.actorKind,
      resource: prev.resource,
      version: prev.version + 1,
      previous: rulesetId(prev),
      ...next,
    };
    const signed = await signRuleset(this.handle, ruleset);
    const asset = await this.handle.keymaster.createAsset([...chain, signed], { registry: this.config.registry });
    await this.setIndex(actor, asset);
  }

  /** Load an actor's signed Ruleset chain (empty if unregistered). */
  async load(actor: string): Promise<SignedRuleset[]> {
    const asset = (await this.index())[actor];
    if (!asset) return [];
    const data = await this.handle.keymaster.resolveAsset(asset).catch(() => null);
    return Array.isArray(data) ? (data as SignedRuleset[]) : [];
  }

  /** Authorize an actor's request against its active Ruleset (fail-closed if unregistered/revoked). */
  async authorize(actor: string, req: ActorRequest): Promise<ActorAuthz> {
    return authorizeActor(this.handle, await this.load(actor), req);
  }
}
