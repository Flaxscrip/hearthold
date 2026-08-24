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
  /**
   * ESCAPE HATCH — skip the peerlessness interrogation and open anyway. Explicit per session only: it is
   * never a default and is never read from config. Set it ONLY for a stand-in whose peerlessness you have
   * verified out of band; opening logs loudly. Omit it and an un-peerless (or unverifiable) target is
   * refused. See docs/dmz/RESULTS.md.
   */
  assumePeerless?: boolean;
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

/**
 * Registries a DMZ target may support and still be PEERLESS — i.e. unable to gossip or anchor a DID anywhere
 * other peers/chains can see. `local` is DB-only, no propagation. ANY other registry — `hyperswarm` (the
 * gossip mediator) or any blockchain registry (`BTC:*`, `ETH:*`, `SOL:*`, `ZEC:*`, …) — makes the node a
 * propagator, so a DMZ pointed at it would re-broadcast what it imports. Deliberately a strict allowlist:
 * anything not listed here counts as peered. Grounded live — a mediator-less Aegis node returns `["local"]`;
 * flaxlap returns `["hyperswarm", "BTC:mainnet", …, "local"]`.
 */
export const PEERLESS_REGISTRIES: ReadonlySet<string> = new Set(['local']);

/** The target supports a propagating registry — a DMZ there could re-broadcast imports. Refused. */
export class PeeredTargetError extends Error {
  constructor(readonly registries: string[]) {
    super(
      `refusing to open a DMZ against a PEERED gatekeeper: it supports propagating registries ` +
        `[${registries.join(', ')}] — only [${[...PEERLESS_REGISTRIES].join(', ')}] is peerless. ` +
        `A DMZ must be unable to re-broadcast what it imports.`,
    );
    this.name = 'PeeredTargetError';
  }
}

/** The target could not answer whether it is peerless (unreachable/errored). Refused — never assumed good. */
export class UndeterminedTargetError extends Error {
  constructor(readonly dmzNodeUrl: string, cause: string) {
    super(
      `refusing to open a DMZ against '${dmzNodeUrl}': cannot determine whether it is peerless (${cause}). ` +
        `An unverifiable target is refused, not assumed good (fail closed).`,
    );
    this.name = 'UndeterminedTargetError';
  }
}

/**
 * Interrogate a DMZ target and confirm it is PEERLESS — BEFORE any session (hence any import) exists. The
 * direct signal is the gatekeeper's own `listRegistries()`: a target that lists ONLY peerless registries
 * cannot gossip, so nothing imported can propagate. Fails closed: a peered target throws `PeeredTargetError`;
 * an unreachable/erroring one throws `UndeterminedTargetError`. `assumePeerless` is the ONLY escape hatch —
 * explicit per call, never a default, never read from config — and it LOGS LOUDLY. Use it only for a
 * stand-in whose peerlessness you have verified out of band.
 */
export async function assertPeerlessTarget(
  target: { listRegistries(): Promise<string[]> },
  dmzNodeUrl: string,
  opts: { assumePeerless?: boolean } = {},
): Promise<{ registries: string[]; assumed: boolean }> {
  if (opts.assumePeerless === true) {
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️  DMZ PEERLESSNESS UNVERIFIED: opening against '${dmzNodeUrl}' under an explicit ` +
        `assumePeerless escape hatch. The target was NOT interrogated — you are asserting out of band that ` +
        `it has no gossip mediator and no peers. NEVER use this against a node that can propagate.`,
    );
    return { registries: [], assumed: true };
  }
  let registries: string[];
  try {
    registries = await target.listRegistries();
  } catch (e) {
    throw new UndeterminedTargetError(dmzNodeUrl, e instanceof Error ? e.message : String(e));
  }
  if (!Array.isArray(registries)) throw new UndeterminedTargetError(dmzNodeUrl, 'listRegistries did not return an array');
  const peered = registries.filter((r) => !PEERLESS_REGISTRIES.has(r));
  if (peered.length > 0) throw new PeeredTargetError(registries);
  return { registries, assumed: false };
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
    let gatekeeper: GatekeeperClient;
    try {
      // Fail-fast client so an unreachable target surfaces at the peerless check, not as a hang.
      gatekeeper = await GatekeeperClient.create({ url: opts.dmzNodeUrl, waitUntilReady: false, maxRetries: 0, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) });
    } catch (e) {
      throw new UndeterminedTargetError(opts.dmzNodeUrl, e instanceof Error ? e.message : String(e));
    }

    // TARGET ISOLATION — confirm the target is peerless BEFORE a session (hence any import) can exist. The
    // type guarantee (PrivateGatekeeper omits import) confines the CAPABILITY; this confirms the TARGET.
    // Both are required. Fails closed on peered/undetermined; the only bypass is an explicit assumePeerless.
    await assertPeerlessTarget(gatekeeper, opts.dmzNodeUrl, { assumePeerless: opts.assumePeerless });

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
