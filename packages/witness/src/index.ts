#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  acceptDelegation,
  WardenClient,
} from '@hearthold/core';

const HELP = `Hearthold Witness — Companion

Usage:
  witness init                 Provision the Witness identity (wallet + did:cid)
  witness status               Show identity and config
  witness accept <credDid>     Accept a delegation credential from the Warden
  witness submit <kind> <text> Seal an observation and submit it to the Warden
  witness help                 Show this message

  <kind> ∈ event | location | activity | browsing | document

Env:
  HEARTHOLD_PASSPHRASE      wallet passphrase (required)
  HEARTHOLD_WARDEN_URL      base URL of the Warden over your private/Tailscale network
                            (e.g. http://100.x.y.z:8787) — required for submit
  HEARTHOLD_GATEKEEPER_URL  default http://flaxlap.local:4224
  HEARTHOLD_DATA_ROOT       default ~/.hearthold
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

  const handle = await openKeymaster('witness', config, passphrase);
  const id = await ensureIdentity(handle, config);

  switch (cmd) {
    case 'init': {
      process.stdout.write(`Witness ready\n  name: ${id.name}\n  did:  ${id.did}\n`);
      break;
    }
    case 'status': {
      process.stdout.write(
        `Witness ${id.did}\n  gatekeeper: ${config.gatekeeperUrl}\n` +
          `  warden:     ${config.wardenUrl ?? '(set HEARTHOLD_WARDEN_URL)'}\n` +
          `  data:       ${handle.dataFolder}\n`,
      );
      break;
    }
    case 'accept': {
      const credDid = process.argv[3];
      if (!credDid) throw new Error('usage: witness accept <credentialDid>');
      const ok = await acceptDelegation(handle, credDid);
      process.stdout.write(ok ? `Accepted delegation ${credDid.slice(0, 28)}…\n` : 'Accept failed.\n');
      break;
    }
    case 'submit': {
      const kind = process.argv[3];
      const text = process.argv.slice(4).join(' ');
      if (!kind || !text) throw new Error('usage: witness submit <kind> <text>');
      if (!config.wardenUrl) throw new Error('HEARTHOLD_WARDEN_URL is required for submit');

      const client = new WardenClient(handle, config.wardenUrl);
      await client.connect();
      const receipt = await client.submit({
        kind: kind as never,
        observedAt: new Date().toISOString(),
        payload: { text },
      });
      process.stdout.write(
        `Submitted ${kind} to Warden ${client.connectedWardenDid?.slice(0, 24)}…\n` +
          `  artefact:    ${receipt.artefactId.slice(0, 28)}…\n` +
          `  sensitivity: ${receipt.assignedSensitivity} (stored ${receipt.storedAt})\n`,
      );
      break;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`witness: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
