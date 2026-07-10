#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  acceptDelegation,
  sealForWarden,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
  type WitnessSubmission,
} from '@hearthold/core';

import { makeEmissaryProjectorHandler } from './handler.js';
import { makeKbRelayHandler } from './kb-relay.js';
import { startKbPortalServer } from './kb-portal-server.js';
import { runEmissaryControl } from './control.js';

const HELP = `Hearthold Emissary — Companion

Usage:
  emissary init                 Provision the Emissary identity + publish its DIDComm endpoint
  emissary status               Show identity and config
  emissary accept <credDid>     Accept a delegation credential from the Warden
  emissary submit <kind> <text> Seal an observation and submit it to the Warden over DIDComm
  emissary serve                Project to the world: relay proof-requests to the Sovereign (Signet)
  emissary kb-portal            Emissary: relay Knowledge Base traffic to the Warden (carries only)
  emissary kb-web [port]        Emissary web portal: HTTP→DIDComm bridge for the browser (default 4313)
  emissary control [port]       Submit + project over DIDComm, with a control API for the Emissary app (default 4312)
  emissary help                 Show this message

  <kind> ∈ event | location | activity | browsing | document

Env:
  HEARTHOLD_PASSPHRASE     wallet passphrase (required)
  HEARTHOLD_WARDEN_DID     the Warden's did:cid — required for submit
  HEARTHOLD_SOVEREIGN_DID  the Sovereign's did:cid — required for serve (relay target)
  HEARTHOLD_NODE_URL       Archon node (Drawbridge) URL; default http://flaxlap.local:4222
  HEARTHOLD_DATA_ROOT      default ~/.hearthold
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

  const handle = await openKeymaster('emissary', config, passphrase);
  const id = await ensureIdentity(handle, config);

  switch (cmd) {
    case 'init': {
      let published = false;
      try {
        await new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl).ready();
        published = true;
      } catch {
        published = false;
      }
      process.stdout.write(
        `Emissary ready\n  name: ${id.name}\n  did:  ${id.did}\n` +
          `  didcomm: ${published ? 'endpoint published' : 'NOT published (run init again once DIDComm is up)'}\n`,
      );
      break;
    }
    case 'status': {
      process.stdout.write(
        `Emissary ${id.did}\n  node:   ${config.nodeUrl}\n` +
          `  warden: ${config.wardenDid ?? '(set HEARTHOLD_WARDEN_DID)'}\n` +
          `  data:   ${handle.dataFolder}\n`,
      );
      break;
    }
    case 'accept': {
      const credDid = process.argv[3];
      if (!credDid) throw new Error('usage: emissary accept <credentialDid>');
      const ok = await acceptDelegation(handle, credDid);
      process.stdout.write(ok ? `Accepted delegation ${credDid.slice(0, 28)}…\n` : 'Accept failed.\n');
      break;
    }
    case 'submit': {
      const kind = process.argv[3];
      const text = process.argv.slice(4).join(' ');
      if (!kind || !text) throw new Error('usage: emissary submit <kind> <text>');
      const wardenDid = config.wardenDid;
      if (!wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is required for submit');

      const transport = new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl);
      await transport.ready();
      const ciphertext = await sealForWarden(handle, wardenDid, JSON.stringify({ text }));
      const submission: WitnessSubmission = {
        type: 'hearthold/witness-submission',
        version: PROTOCOL_VERSION,
        kind: kind as never,
        observedAt: new Date().toISOString(),
        ciphertext,
      };
      const reply = await transport.request(wardenDid, submission);

      if (reply.type === 'hearthold/submission-receipt') {
        process.stdout.write(
          `Submitted ${kind} to Warden ${wardenDid.slice(0, 24)}…\n` +
            `  artefact:    ${reply.artefactId.slice(0, 28)}…\n` +
            `  sensitivity: ${reply.assignedSensitivity} (stored ${reply.storedAt})\n`,
        );
      } else if (reply.type === 'hearthold/error') {
        process.stderr.write(`Warden refused: ${reply.reason}\n`);
        process.exitCode = 1;
      } else {
        process.stderr.write(`Unexpected reply: ${reply.type}\n`);
        process.exitCode = 1;
      }
      break;
    }
    case 'control': {
      const port = Number(process.argv[3] ?? process.env.HEARTHOLD_CONTROL_PORT ?? 4312);
      await runEmissaryControl(handle, config, port);
      break;
    }
    case 'serve': {
      const sovereignDid = config.sovereignDid;
      if (!sovereignDid) {
        throw new Error(
          'HEARTHOLD_SOVEREIGN_DID is required to serve — the Emissary relays disclosures to the Sovereign',
        );
      }
      const transport = new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl);
      await transport.ready();
      const stop = await transport.serve(makeEmissaryProjectorHandler(transport, sovereignDid));
      process.stdout.write(
        `Emissary projecting over DIDComm (relays proof-requests to the Sovereign/Signet)\n` +
          `  did:       ${id.did}\n` +
          `  sovereign: ${sovereignDid.slice(0, 28)}…\n  (Ctrl-C to stop)\n`,
      );
      const shutdown = (): void => {
        stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'kb-portal': {
      const wardenDid = config.wardenDid;
      if (!wardenDid) {
        throw new Error('HEARTHOLD_WARDEN_DID is required — the KB portal relays to the Warden');
      }
      const transport = new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl);
      await transport.ready();
      const stop = await transport.serve(makeKbRelayHandler(transport, wardenDid));
      process.stdout.write(
        `Emissary serving as the KB portal — relaying to the Warden\n` +
          `  did:    ${id.did}\n  warden: ${wardenDid.slice(0, 28)}…\n  (carries only; holds no secret) (Ctrl-C to stop)\n`,
      );
      const shutdown = (): void => {
        stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'kb-web': {
      const wardenDid = config.wardenDid;
      if (!wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is required — the portal relays to the Warden');
      const port = Number(process.argv[3] ?? process.env.HEARTHOLD_PORTAL_PORT ?? 4313);
      const host = process.env.HEARTHOLD_PORTAL_HOST ?? '127.0.0.1';
      // Public base URL baked into the login callback the wallet POSTs to (set for a real deployment).
      const publicUrl = process.env.HEARTHOLD_PORTAL_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
      const transport = new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl);
      await transport.ready();
      const server = startKbPortalServer({ transport, wardenDid, port, host, publicUrl });
      const shutdown = (): void => {
        server.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`emissary: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
