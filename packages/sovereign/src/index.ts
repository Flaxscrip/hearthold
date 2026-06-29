#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  acceptCredential,
  recordIssuedCredential,
  agentDataFolder,
  IssuedStore,
  DidCommTransport,
  IDENTITY_NAME,
} from '@hearthold/core';

import { makeSovereignHandler } from './handler.js';

const HELP = `Hearthold Sovereign — the principal (Signet precursor)

Usage:
  sovereign init             Provision the Sovereign identity + publish its DIDComm endpoint
  sovereign status           Show identity and config
  sovereign accept <credDid> Accept a third-party credential and record it in the vault
  sovereign issued           List the issued (third-party) credentials in the vault
  sovereign serve            Serve over DIDComm: present proofs on request
  sovereign help             Show this message

Env:
  HEARTHOLD_PASSPHRASE   wallet passphrase (required)
  HEARTHOLD_NODE_URL     Archon node (Drawbridge) URL; default http://flaxlap.local:4222
  HEARTHOLD_DATA_ROOT    default ~/.hearthold
`;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  const passphrase = process.env.HEARTHOLD_PASSPHRASE;
  if (!passphrase) throw new Error('HEARTHOLD_PASSPHRASE is required');

  const handle = await openKeymaster('sovereign', config, passphrase);
  const id = await ensureIdentity(handle, config);

  // Third-party credentials are about the Sovereign but custodied in the Warden's vault.
  const vaultFolder = agentDataFolder(config, 'warden');

  switch (cmd) {
    case 'init': {
      let published = false;
      try {
        await new DidCommTransport(handle, IDENTITY_NAME.sovereign, config.nodeUrl).ready();
        published = true;
      } catch {
        published = false;
      }
      process.stdout.write(
        `Sovereign ready\n  name: ${id.name}\n  did:  ${id.did}\n` +
          `  didcomm: ${published ? 'endpoint published' : 'NOT published (run init again once DIDComm is up)'}\n`,
      );
      break;
    }
    case 'serve': {
      const transport = new DidCommTransport(handle, IDENTITY_NAME.sovereign, config.nodeUrl);
      await transport.ready();
      const stop = await transport.serve(makeSovereignHandler(handle));
      process.stdout.write(
        `Sovereign serving over DIDComm (presenting proofs on request)\n  did: ${id.did}\n  (Ctrl-C to stop)\n`,
      );
      const shutdown = (): void => {
        stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'status': {
      const issued = await new IssuedStore(vaultFolder).list();
      process.stdout.write(
        `Sovereign ${id.did}\n  node:   ${config.nodeUrl}\n` +
          `  data:   ${handle.dataFolder}\n  issued: ${issued.length} credential(s) in vault\n`,
      );
      break;
    }
    case 'accept': {
      const credDid = process.argv[3];
      if (!credDid) throw new Error('usage: sovereign accept <credentialDid>');
      const ok = await acceptCredential(handle, credDid);
      if (!ok) throw new Error('acceptCredential failed');
      const leaf = await recordIssuedCredential(handle, credDid, vaultFolder);
      process.stdout.write(
        `Accepted + recorded issued credential\n` +
          `  type:   ${leaf.credentialType}\n` +
          `  issuer: ${leaf.issuer.slice(0, 32)}…\n` +
          `  claims: ${JSON.stringify(leaf.claims)}\n`,
      );
      break;
    }
    case 'issued': {
      const issued = await new IssuedStore(vaultFolder).list();
      if (issued.length === 0) {
        process.stdout.write('No issued credentials in vault.\n');
        break;
      }
      for (const l of issued) {
        process.stdout.write(
          `[issued] ${l.credentialType} from ${l.issuer.slice(0, 24)}… · ${JSON.stringify(l.claims)}\n`,
        );
      }
      process.stdout.write(`${issued.length} issued credential(s).\n`);
      break;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`sovereign: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
