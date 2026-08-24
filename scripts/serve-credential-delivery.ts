/**
 * Receiver daemon for cross-node credential delivery — the subject side of the PHASE-4 seam.
 *
 * Opens the subject's Hearthold wallet and serves `makeCredentialDeliveryHandler` over DIDComm until
 * interrupted: for each `hearthold/credential-delivery` message it imports the shipped ops, accepts the
 * credential, and replies with an ack. Reopens a FRESH handle per request (reload-before-write) so a
 * concurrent wallet change is never clobbered.
 *
 *   node --experimental-strip-types scripts/serve-credential-delivery.ts [--subject-role sovereign]
 *
 * Config from the environment (as in the e2e scripts): HEARTHOLD_GATEKEEPER_URL, HEARTHOLD_REGISTRY,
 * HEARTHOLD_DATA_ROOT, HEARTHOLD_PASSPHRASE. Point HEARTHOLD_DATA_ROOT at the subject agent's wallet dir.
 */

import {
  loadConfig,
  openKeymaster,
  openKeymasterFresh,
  DidCommTransport,
  IDENTITY_NAME,
  makeCredentialDeliveryHandler,
  type AgentRole,
} from '@hearthold/core';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const role = (arg('subject-role') ?? 'sovereign') as AgentRole;
  const passphrase = process.env.HEARTHOLD_PASSPHRASE;
  if (!passphrase) throw new Error('HEARTHOLD_PASSPHRASE is required');

  const config = loadConfig();
  const subject = await openKeymaster(role, config, passphrase);
  const idName = IDENTITY_NAME[role];

  const transport = new DidCommTransport(subject, idName, config.nodeUrl);
  await transport.ready();

  const handler = makeCredentialDeliveryHandler(subject, idName, {
    // Reload-before-write: accepting a credential mutates the wallet, so serve from a fresh handle.
    reopen: () => openKeymasterFresh(role, config, passphrase),
    // Wire the VC→KB bridge here (ingestCredentialToPartition) to auto-ingest accepted credentials.
    // onAccepted: async (handle, credDid) => (await ingestCredentialToPartition(handle, config, { … })).artefactId,
  });

  const stop = await transport.serve(handler, { pollMs: 1000 });
  process.stdout.write(`serving credential-delivery as ${idName} (${config.nodeUrl}); Ctrl-C to stop\n`);

  const shutdown = (): void => {
    stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`serve-credential-delivery error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
