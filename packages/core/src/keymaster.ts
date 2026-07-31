import Keymaster, { WalletJson } from '@didcid/keymaster';
import GatekeeperClient from '@didcid/gatekeeper/client';
import CipherNode from '@didcid/cipher/node';

import type { AgentRole, HearthholdConfig } from './config.js';
import { agentDataFolder } from './config.js';

/**
 * The node's OWN gatekeeper client, structurally stripped of the foreign-import methods.
 *
 * Importing a counterparty's operations into the node's own (peer-connected) Gatekeeper re-broadcasts their
 * identifiers — "holding is republishing" (docs/DEPLOYMENT.md) — which is the B6 GATEKEEPER PURITY boundary
 * (docs/pvm-boundaries/RESULTS.md). By removing `importDIDs`/`importBatch`/`importBatchByCids` from the type,
 * importing foreign ops into the private gatekeeper is a **compile error**, not a scan we hope stays clean —
 * B6 becomes impossible-by-type. Export, resolve, and processEvents remain (they don't ingest foreign DIDs).
 * The ONLY importer in the codebase is a DMZ session (`dmz.ts`), which owns a full client pointed at an
 * ephemeral, peerless instance — never the node's own.
 */
export type PrivateGatekeeper = Omit<GatekeeperClient, 'importDIDs' | 'importBatch' | 'importBatchByCids'>;

export interface KeymasterHandle {
  role: AgentRole;
  keymaster: Keymaster;
  /** The cipher instance, retained for in-band (non-anchoring) encrypt/decrypt. */
  cipher: CipherNode;
  /** The node's own gatekeeper client — export/resolve/processEvents, but NOT foreign import (see PrivateGatekeeper). */
  gatekeeper: PrivateGatekeeper;
  dataFolder: string;
  /** The anchoring registry this handle writes on (`config.registry`) — `local` applies writes immediately;
   *  any other (hyperswarm, chain) QUEUES them until `processEvents`. Consulted by the transport on publish. */
  registry: string;
}

/**
 * Instantiate Keymaster as a library for one Hearthold agent — its own file-backed wallet,
 * connected to the Archon Gatekeeper. This is deliberately NOT the node's keymaster HTTP service:
 * each agent custodies its own wallet so the Emissary identity can later migrate to other devices.
 */
export async function openKeymaster(
  role: AgentRole,
  config: HearthholdConfig,
  passphrase: string,
): Promise<KeymasterHandle> {
  const gatekeeper = await GatekeeperClient.create({ url: config.nodeUrl });
  const dataFolder = agentDataFolder(config, role);
  const wallet = new WalletJson('wallet.json', dataFolder);
  const cipher = new CipherNode();

  const keymaster = new Keymaster({
    passphrase,
    gatekeeper,
    wallet,
    cipher,
    // CONTENT is born on `contentRegistry` (default `local`): issued credentials, image assets, schemas — all
    // default here, so a federated Sovereign's *content* stays local while its *identity* federates. The
    // IDENTITY itself is created explicitly on `config.registry` (ensureIdentity → createId), and ephemerals
    // on `config.ephemeralRegistry` (below), so those remain identity-aligned. On the all-`local` default the
    // two coincide → no behavioural change; the split only bites once `HEARTHOLD_REGISTRY` becomes hyperswarm.
    defaultRegistry: config.contentRegistry,
  });
  // A challenge/response DID is controlled by this agent's identity DID (on config.registry). Keymaster
  // hardcodes the ephemeral default to `hyperswarm` and does NOT inherit `defaultRegistry`, so a `local`
  // identity minting a response on `hyperswarm` is refused — the gatekeeper won't anchor a DID on a
  // registry whose peers can't resolve its controller (an opaque "Upstream gatekeeper error"). Align the
  // ephemeral registry with the identity's registry so the response is controlled by a same-registry,
  // resolvable DID. The field is a plain writable instance field at runtime; the .d.ts hides it, so we
  // assign past the type (an upstream `ephemeralRegistry` constructor option would remove the need to cast).
  (keymaster as unknown as { ephemeralRegistry: string }).ephemeralRegistry = config.ephemeralRegistry;

  return { role, keymaster, cipher, gatekeeper, dataFolder, registry: config.registry };
}

/**
 * Open a fresh handle AND force its wallet to load from disk now, retrying a torn read.
 *
 * A new keymaster reads `wallet.json` with an empty cache, so this is how a long-lived daemon re-reads
 * an agent's wallet after another process (e.g. `sovereign accept`) wrote it — same local file, same
 * passphrase, no new source (see docs/attenuation notwithstanding: the trust boundary is identical to a
 * normal open). Keymaster's `saveWallet` is non-atomic (`writeFileSync`, no temp-rename), so a reload that
 * races a concurrent write can read a truncated file and fail to parse/decrypt. We force the read here —
 * where it is catchable — and retry with a short backoff so a rare mid-write race recovers instead of
 * surfacing a transient error. Fails CLOSED: if every attempt reads a bad file, it throws (no disclosure).
 */
export async function openKeymasterFresh(
  role: AgentRole,
  config: HearthholdConfig,
  passphrase: string,
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<KeymasterHandle> {
  const handle = await openKeymaster(role, config, passphrase);
  await reloadWallet(handle, opts);
  return handle;
}

/**
 * Force an EXISTING handle's wallet to re-read from disk now, retrying a torn read. This is the
 * reload-before-write primitive: a long-lived daemon caches the wallet in memory at open, so before it
 * signs/saves it must re-read to pick up a write from a SEPARATE process (a CLI `rotate`, an `accept`) —
 * otherwise its non-atomic `saveWallet` writes a stale cache back over the external change (clobber).
 * Keymaster's `saveWallet` is `writeFileSync` with no temp-rename, so a reload that races a concurrent
 * write can read a truncated file and fail to parse/decrypt; we retry with a short backoff and, if every
 * attempt reads a bad file, throw — failing CLOSED (no disclosure through a half-loaded wallet). Reuses the
 * handle (unlike `openKeymasterFresh`, which mints a new one) so callers sharing it see the refreshed cache.
 */
export async function reloadWallet(
  handle: KeymasterHandle,
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<void> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 50;
  for (let attempt = 0; ; attempt++) {
    try {
      // On failure the wallet cache is left unset, so the next attempt re-reads the file (no stale/partial
      // state carries over).
      await handle.keymaster.loadWallet();
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
    }
  }
}

/**
 * Resolve an agent's wallet passphrase: a per-role `HEARTHOLD_PASSPHRASE_<ROLE>` if set, else the shared
 * `HEARTHOLD_PASSPHRASE`. Per-role secrets let a deployment give each agent its OWN passphrase so a single
 * leak doesn't collapse the PVM separation (custodian ≠ actor ≠ authorizer) — while a single shared value
 * still works for co-located dev. Throws (fail-closed) when neither is set; never logs or echoes the value.
 */
export function passphraseFor(role: AgentRole): string {
  const key = `HEARTHOLD_PASSPHRASE_${role.toUpperCase()}`;
  const pass = process.env[key] ?? process.env.HEARTHOLD_PASSPHRASE;
  if (!pass) throw new Error(`no wallet passphrase — set ${key} (per-role) or HEARTHOLD_PASSPHRASE (shared)`);
  return pass;
}

/**
 * Incident-response key maintenance for an agent's own wallet — the built-in path for a compromised key or
 * passphrase. Always reloads from disk first (never operate on a stale cache), then:
 *   `rotate`      — rotate the identity's signing keys forward (existing DIDs keep resolving; the retired
 *                   key can no longer sign). Run per identity the agent holds.
 *   `passphrase`  — re-encrypt the wallet at rest under a NEW passphrase (update the env before next start).
 *   `check`       — a health check of the wallet (mnemonic/DID/key consistency).
 * Returns a human-readable result line; the passphrase is never logged.
 */
export async function runKeyMaintenance(
  handle: KeymasterHandle,
  op: 'rotate' | 'passphrase' | 'check',
  newPassphrase?: string,
): Promise<string> {
  await reloadWallet(handle);
  switch (op) {
    case 'rotate': {
      const ok = await handle.keymaster.rotateKeys();
      return ok
        ? 'rotated the current identity’s signing keys (existing DIDs keep resolving; the old key can no longer sign)'
        : 'rotateKeys returned false — nothing to rotate (no current identity?)';
    }
    case 'passphrase': {
      if (!newPassphrase) throw new Error('a new passphrase is required (usage: passphrase <new-passphrase>)');
      const ok = await handle.keymaster.changePassphrase(newPassphrase);
      return ok
        ? 'wallet re-encrypted under the new passphrase — update HEARTHOLD_PASSPHRASE(_<ROLE>) before the next start'
        : 'changePassphrase returned false — the wallet was not re-encrypted';
    }
    case 'check': {
      const r = await handle.keymaster.checkWallet();
      return `wallet check: ${JSON.stringify(r)}`;
    }
  }
}
