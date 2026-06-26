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
 * each agent custodies its own wallet so the Witness identity can later migrate to other devices.
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

  return { role, keymaster, cipher, dataFolder };
}
