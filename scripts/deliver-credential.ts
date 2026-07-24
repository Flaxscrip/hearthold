/**
 * Sender entrypoint for cross-node credential delivery — the PHASE-4 seam replacement.
 *
 * Opens the issuer's Hearthold wallet, brings up a DIDComm transport, and delivers a credential to a
 * subject agent, printing the subject's ack as JSON. Exits 0 iff the subject accepted.
 *
 *   node --experimental-strip-types scripts/deliver-credential.ts <subjectDid> <credentialDid> \
 *       [--issuer-role warden] [--schema <schemaDid>] [--include-issuer-ops] [--timeout-ms 60000]
 *
 * Config comes from the environment exactly like the e2e scripts:
 *   HEARTHOLD_GATEKEEPER_URL, HEARTHOLD_REGISTRY, HEARTHOLD_DATA_ROOT, HEARTHOLD_PASSPHRASE.
 * Point HEARTHOLD_DATA_ROOT at the wallet dir of the issuer agent and HEARTHOLD_GATEKEEPER_URL at the node
 * that agent runs against. The subject side must be running `serve-credential-delivery.ts`.
 */

import {
  loadConfig,
  openKeymaster,
  DidCommTransport,
  IDENTITY_NAME,
  deliverCredential,
  type AgentRole,
} from '@hearthold/core';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const [, , toDid, credentialDid] = process.argv;
  if (!toDid || !credentialDid || toDid.startsWith('--') || credentialDid.startsWith('--')) {
    process.stderr.write('usage: deliver-credential.ts <subjectDid> <credentialDid> [--issuer-role warden] [--schema <did>] [--include-issuer-ops] [--timeout-ms N]\n');
    process.exit(2);
  }

  const role = (arg('issuer-role') ?? 'warden') as AgentRole;
  const passphrase = process.env.HEARTHOLD_PASSPHRASE;
  if (!passphrase) throw new Error('HEARTHOLD_PASSPHRASE is required');

  const config = loadConfig();
  const issuer = await openKeymaster(role, config, passphrase);
  const idName = IDENTITY_NAME[role];

  const transport = new DidCommTransport(issuer, idName, config.nodeUrl);
  await transport.ready();

  const timeoutMs = arg('timeout-ms') ? Number(arg('timeout-ms')) : undefined;
  const ack = await deliverCredential(issuer, idName, transport, toDid, credentialDid, {
    schemaDid: arg('schema'),
    includeIssuerOps: has('include-issuer-ops'),
    timeoutMs,
  });

  process.stdout.write(`${JSON.stringify(ack, null, 2)}\n`);
  process.exit(ack.accepted ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`deliver-credential error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
