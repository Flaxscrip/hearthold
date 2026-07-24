import Keymaster, { WalletJson } from '@didcid/keymaster';
import GatekeeperClient from '@didcid/gatekeeper/client';
import CipherNode from '@didcid/cipher/node';

import type { AgentRole, HearthholdConfig } from './config.js';
import { agentDataFolder } from './config.js';

export interface KeymasterHandle {
  role: AgentRole;
  keymaster: Keymaster;
  /** The cipher instance, retained for in-band (non-anchoring) encrypt/decrypt. */
  cipher: CipherNode;
  /** The gatekeeper client — for admin export/import of DID ops (cross-node credential delivery). */
  gatekeeper: GatekeeperClient;
  dataFolder: string;
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
    defaultRegistry: config.registry,
  });
  // A challenge/response DID is controlled by this agent's identity DID (on config.registry). Keymaster
  // hardcodes the ephemeral default to `hyperswarm` and does NOT inherit `defaultRegistry`, so a `local`
  // identity minting a response on `hyperswarm` is refused — the gatekeeper won't anchor a DID on a
  // registry whose peers can't resolve its controller (an opaque "Upstream gatekeeper error"). Align the
  // ephemeral registry with the identity's registry so the response is controlled by a same-registry,
  // resolvable DID. The field is a plain writable instance field at runtime; the .d.ts hides it, so we
  // assign past the type (an upstream `ephemeralRegistry` constructor option would remove the need to cast).
  (keymaster as unknown as { ephemeralRegistry: string }).ephemeralRegistry = config.ephemeralRegistry;

  return { role, keymaster, cipher, gatekeeper, dataFolder };
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
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 50;
  const handle = await openKeymaster(role, config, passphrase);
  for (let attempt = 0; ; attempt++) {
    try {
      // Force the fresh disk read now. On failure the wallet cache is left unset, so the next attempt
      // re-reads the file (no stale/partial state carries over).
      await handle.keymaster.loadWallet();
      return handle;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
    }
  }
}
