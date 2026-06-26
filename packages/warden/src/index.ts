#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  AuthzTier,
  Sensitivity,
  requiredTier,
} from '@hearthold/core';

import { createClassifier } from './classifier.js';
import { VaultStore } from './store.js';
import { WardenService } from './service.js';
import { WardenServer } from './server.js';

const HELP = `Hearthold Warden — home Keeper

Usage:
  warden init              Provision the Warden identity (wallet + did:cid)
  warden status            Show identity, vault size, and config
  warden delegate <did>    Issue a delegation credential to a Witness DID
  warden serve             Start the HTTP service (bind to a private/Tailscale interface)
  warden vault             List stored artefacts (metadata only; payloads stay encrypted)
  warden help              Show this message

Env:
  HEARTHOLD_PASSPHRASE      wallet passphrase (required)
  HEARTHOLD_GATEKEEPER_URL  default http://flaxlap.local:4224
  HEARTHOLD_DATA_ROOT       default ~/.hearthold
  HEARTHOLD_WARDEN_BIND     bind address for serve (default 127.0.0.1; set tailnet IP or 0.0.0.0)
  HEARTHOLD_WARDEN_PORT     port for serve (default 8787)
`;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  const passphrase = process.env.HEARTHOLD_PASSPHRASE;
  if (!passphrase) {
    throw new Error('HEARTHOLD_PASSPHRASE is required');
  }

  const handle = await openKeymaster('warden', config, passphrase);

  switch (cmd) {
    case 'init': {
      const id = await ensureIdentity(handle, config);
      process.stdout.write(`Warden ready\n  name: ${id.name}\n  did:  ${id.did}\n`);
      break;
    }
    case 'status': {
      const id = await ensureIdentity(handle, config);
      const vault = new VaultStore(handle.dataFolder);
      const items = await vault.list();
      createClassifier(); // ensure the local classifier wiring resolves
      process.stdout.write(
        `Warden ${id.did}\n` +
          `  gatekeeper: ${config.gatekeeperUrl}\n` +
          `  data:       ${handle.dataFolder}\n` +
          `  bind:       ${config.bindAddr}:${config.port}\n` +
          `  artefacts:  ${items.length}\n` +
          `  e.g. SEALED requires tier ${requiredTier(Sensitivity.SEALED)} ` +
          `(MULTIFACTOR=${AuthzTier.MULTIFACTOR})\n`,
      );
      break;
    }
    case 'delegate': {
      const witnessDid = process.argv[3];
      if (!witnessDid) throw new Error('usage: warden delegate <witnessDid>');
      await ensureIdentity(handle, config);
      const schemaDid = await ensureDelegationSchema(handle);
      const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
      const credentialDid = await issueDelegation(handle, witnessDid, schemaDid, {
        kinds: ['event', 'location', 'activity', 'browsing', 'document'],
        validUntil,
      });
      process.stdout.write(
        `Delegation issued to ${witnessDid.slice(0, 28)}…\n` +
          `  credential: ${credentialDid}\n` +
          `  → run on the Witness:  witness accept ${credentialDid}\n`,
      );
      break;
    }
    case 'serve': {
      const id = await ensureIdentity(handle, config);
      const server = new WardenServer(handle);
      const { addr, port } = await server.listen(config.bindAddr, config.port);
      process.stdout.write(
        `Warden serving\n  did:  ${id.did}\n  bind: http://${addr}:${port}\n` +
          `  (Ctrl-C to stop)\n`,
      );
      const stop = (): void => {
        void server.close().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break;
    }
    case 'vault': {
      await ensureIdentity(handle, config);
      const service = new WardenService(handle);
      const items = await service.listArtefacts();
      if (items.length === 0) {
        process.stdout.write('Vault is empty.\n');
        break;
      }
      for (const a of items) {
        process.stdout.write(
          `[${a.sensitivity}] ${a.kind} observed ${a.observedAt} · ${a.id.slice(0, 28)}…\n`,
        );
      }
      process.stdout.write(`${items.length} artefact(s).\n`);
      break;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`warden: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
