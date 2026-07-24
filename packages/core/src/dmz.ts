/**
 * The DMZ session — verification without republication.
 *
 * B6 GATEKEEPER PURITY (docs/pvm-boundaries/RESULTS.md) forbids importing a counterparty's operations into
 * the node's OWN Gatekeeper: on a peer-connected node that re-broadcasts their identifiers ("holding is
 * republishing", docs/DEPLOYMENT.md). The fix is to route every foreign import through an **ephemeral,
 * peerless** Gatekeeper — a DMZ — verify there, keep only the minimal closure (closure.ts), then tear the
 * DMZ down. A Gatekeeper with no gossip mediator has nothing to propagate through, so importing to verify
 * no longer republishes (grounded in docs/DRAWBRIDGE-GROUNDING.md: `resolveDID` is pure DB-read + local
 * replay; only the hyperswarm mediator process pushes ops onto the wire).
 *
 * This module owns the ONLY full Gatekeeper client in Hearthold — the one with `importDIDs`. The node's own
 * handle is a `PrivateGatekeeper` with those methods removed (keymaster.ts), so importing foreign ops
 * anywhere but a DMZ is a COMPILE error. B6 is impossible-by-type, not merely unobserved by a scan.
 *
 * Lifecycle: OPEN (Warden-only, reversible, publishes nothing → no co-sign) · IMPORT (full chain, per DID,
 * from genesis — export has no pagination, grounded in DRAWBRIDGE-GROUNDING) · VERIFY (replay + verify
 * signatures across key epochs, reusing the rotation-safety path) · DECIDE (compute the keep closure;
 * Sovereign decides) · TEARDOWN (destroy the session; assert nothing survives).
 */

import Keymaster, { WalletJson } from '@didcid/keymaster';
import GatekeeperClient from '@didcid/gatekeeper/client';
import CipherNode from '@didcid/cipher/node';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';

import type { AgentRole, HearthholdConfig } from './config.js';
import { agentDataFolder } from './config.js';

export interface DmzOpenOptions {
  /**
   * The ephemeral, PEERLESS Gatekeeper this DMZ imports into. It MUST have no gossip mediator (so nothing
   * imported can propagate) and SHOULD NOT be the node's own gatekeeper. Point it at Aegis's mediator-less
   * two-node instance (docs/DRAWBRIDGE-GROUNDING.md). Peerlessness is a deployment property of the instance
   * you name here — this module cannot verify it from the client, so name it deliberately.
   */
  dmzNodeUrl: string;
  /** Admin API key, if the DMZ gatekeeper gates `/dids/import` (dev/isolated instances leave this unset). */
  apiKey?: string;
  /** Whose wallet backs the DMZ keymaster — needed to decrypt/verify credentials sealed to that identity. */
  role: AgentRole;
  config: HearthholdConfig;
  passphrase: string;
}

export class DmzSessionClosedError extends Error {
  constructor(op: string) {
    super(`DMZ session is torn down; '${op}' is not allowed after teardown (fail closed)`);
    this.name = 'DmzSessionClosedError';
  }
}

const stripSlash = (u: string): string => u.replace(/\/+$/, '');

/**
 * An open DMZ session. Holds the full-import Gatekeeper client and a Keymaster bound to it. Every method
 * fails closed once torn down.
 */
export class DmzSession {
  private state: 'open' | 'destroyed' = 'open';
  /** Top-level DIDs this session brought in (for teardown accounting + the "nothing survives" assertion). */
  private readonly touched = new Set<string>();

  private constructor(
    /** The ONLY full Gatekeeper client (with importDIDs) in Hearthold. Peerless by deployment. */
    readonly gatekeeper: GatekeeperClient,
    /** Keymaster bound to the DMZ gatekeeper — resolves/verifies against imported ops, not the node's own. */
    readonly keymaster: Keymaster,
    readonly dmzNodeUrl: string,
  ) {}

  /** OPEN — Warden-only, reversible, publishes nothing (no co-sign per docs/CO-SIGN-POLICY.md). */
  static async open(opts: DmzOpenOptions): Promise<DmzSession> {
    if (!opts.dmzNodeUrl) throw new Error('DMZ open: dmzNodeUrl is required (fail closed — no ambient target)');
    const gatekeeper = await GatekeeperClient.create({ url: opts.dmzNodeUrl, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) });
    const wallet = new WalletJson('wallet.json', agentDataFolder(opts.config, opts.role));
    const cipher = new CipherNode();
    const keymaster = new Keymaster({ passphrase: opts.passphrase, gatekeeper, wallet, cipher, defaultRegistry: opts.config.registry });
    (keymaster as unknown as { ephemeralRegistry: string }).ephemeralRegistry = opts.config.ephemeralRegistry;
    return new DmzSession(gatekeeper, keymaster, stripSlash(opts.dmzNodeUrl));
  }

  private assertOpen(op: string): void {
    if (this.state !== 'open') throw new DmzSessionClosedError(op);
  }

  /** The DIDs this session has touched (for teardown accounting). */
  get scope(): string[] {
    return [...this.touched];
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  /**
   * IMPORT — bring a counterparty's operation export into the DMZ (never the node's own gatekeeper). Import
   * is best-effort so a stand-in DMZ (an instance where `/dids/import` is admin-gated) still works when the
   * ops are already resolvable there; it is fatal only when a DID genuinely does not resolve afterwards
   * (fail closed — we will not verify against ops we could not load). `dids` are recorded for teardown.
   */
  async import(ops: GatekeeperEvent[][], dids: string[]): Promise<void> {
    this.assertOpen('import');
    for (const d of dids) this.touched.add(d);
    try {
      await this.gatekeeper.importDIDs(ops);
      await this.gatekeeper.processEvents();
    } catch (importErr) {
      for (const did of dids) {
        const doc = await this.keymaster.resolveDID(did).catch(() => null);
        if (!doc?.didDocument?.id) throw importErr; // required op unavailable → fail closed
      }
    }
  }

  /**
   * VERIFY — reconstruct a DID from its operations and verify EVERY operation's signature, including across
   * key rotations. `resolveDID(verify:true)` replays the chain and re-checks each op against the controlling
   * key AT THAT VERSION (the rotation-safety property, grounded in e2e-rotation-safety). Returns ok + the
   * pinned version reached, or the failure. Does not decrypt payloads — this is operation-signature verify.
   */
  async verifyChain(did: string): Promise<{ ok: boolean; versionSequence?: number; versionId?: string; reason?: string }> {
    this.assertOpen('verifyChain');
    try {
      const doc = await this.keymaster.resolveDID(did, { verify: true });
      const meta = doc.didDocumentMetadata as { versionId?: string; versionSequence?: string | number } | undefined;
      if (!doc.didDocument?.id) return { ok: false, reason: 'did did not resolve in the DMZ' };
      return { ok: true, versionSequence: meta?.versionSequence != null ? Number(meta.versionSequence) : undefined, versionId: meta?.versionId };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * VERIFY (payload) — verify a signed artifact's proof against the DMZ-held issuer, across key epochs.
   * Reuses `verifyProof`, which resolves the signer at the credential-matching key version (rotation-safety).
   */
  async verifyProof<T extends object>(obj: T): Promise<boolean> {
    this.assertOpen('verifyProof');
    return this.keymaster.verifyProof(obj).catch(() => false);
  }

  /**
   * TEARDOWN — destroy the session. Marks it closed so every further operation fails closed, and clears the
   * touched set. The DMZ instance itself is ephemeral: its data is destroyed by tearing the peerless
   * instance down (external, Aegis-owned). `assertNothingSurvives()` confirms the session holds no residue.
   */
  teardown(): void {
    this.state = 'destroyed';
    this.touched.clear();
  }

  /** After teardown, the session must retain nothing and refuse use. */
  assertNothingSurvives(): { destroyed: boolean; residue: string[] } {
    return { destroyed: this.state === 'destroyed', residue: [...this.touched] };
  }
}
