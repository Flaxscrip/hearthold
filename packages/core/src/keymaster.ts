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

  return { role, keymaster, cipher, dataFolder };
}
