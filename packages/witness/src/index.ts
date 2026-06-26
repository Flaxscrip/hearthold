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

const HELP = `Hearthold Witness — Companion

Usage:
  witness init                 Provision the Witness identity (wallet + did:cid)
  witness status               Show identity and config
  witness accept <credDid>     Accept a delegation credential from the Warden
  witness submit <kind> <text> Seal an observation and submit it to the Warden over DIDComm
  witness help                 Show this message

  <kind> ∈ event | location | activity | browsing | document

Env:
  HEARTHOLD_PASSPHRASE   wallet passphrase (required)
  HEARTHOLD_WARDEN_DID   the Warden's did:cid — required for submit
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

  const handle = await openKeymaster('witness', config, passphrase);
  const id = await ensureIdentity(handle, config);

  switch (cmd) {
    case 'init': {
      process.stdout.write(`Witness ready\n  name: ${id.name}\n  did:  ${id.did}\n`);
      break;
    }
    case 'status': {
      process.stdout.write(
        `Witness ${id.did}\n  node:   ${config.nodeUrl}\n` +
          `  warden: ${config.wardenDid ?? '(set HEARTHOLD_WARDEN_DID)'}\n` +
          `  data:   ${handle.dataFolder}\n`,
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
      const wardenDid = config.wardenDid;
      if (!wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is required for submit');

      const transport = new DidCommTransport(handle, IDENTITY_NAME.witness, config.nodeUrl);
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
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`witness: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
