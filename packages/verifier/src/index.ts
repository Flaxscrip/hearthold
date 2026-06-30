#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  requestProof,
  verifyProof,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
  type ProofPresentationMessage,
} from '@hearthold/core';

const HELP = `Hearthold Verifier — a relying party

Usage:
  verifier init                                       Provision the verifier identity + endpoint
  verifier status                                     Show identity and config
  verifier verify <presenterDid> <schemaDid> <issuerDid> [key=value ...]
                                                      Request a proof and verify it. <presenterDid>
                                                      is whoever fields the request — the Sovereign
                                                      directly, or (preferred) the Witness projector,
                                                      which relays to the Signet. Trusts <issuerDid>;
                                                      optional key=value require claims.
  verifier help                                       Show this message

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

  const handle = await openKeymaster('verifier', config, passphrase);
  const id = await ensureIdentity(handle, config);

  switch (cmd) {
    case 'init': {
      let published = false;
      try {
        await new DidCommTransport(handle, IDENTITY_NAME.verifier, config.nodeUrl).ready();
        published = true;
      } catch {
        published = false;
      }
      process.stdout.write(
        `Verifier ready\n  name: ${id.name}\n  did:  ${id.did}\n` +
          `  didcomm: ${published ? 'endpoint published' : 'NOT published (try again once DIDComm is up)'}\n`,
      );
      break;
    }
    case 'status': {
      process.stdout.write(`Verifier ${id.did}\n  node: ${config.nodeUrl}\n  data: ${handle.dataFolder}\n`);
      break;
    }
    case 'verify': {
      const presenterDid = process.argv[3];
      const schemaDid = process.argv[4];
      const issuerDid = process.argv[5];
      if (!presenterDid || !schemaDid || !issuerDid) {
        throw new Error('usage: verifier verify <presenterDid> <schemaDid> <issuerDid> [key=value ...]');
      }
      const requiredClaims: Record<string, unknown> = {};
      for (const kv of process.argv.slice(6)) {
        const eq = kv.indexOf('=');
        if (eq > 0) requiredClaims[kv.slice(0, eq)] = kv.slice(eq + 1);
      }

      const transport = new DidCommTransport(handle, IDENTITY_NAME.verifier, config.nodeUrl);
      await transport.ready();

      process.stdout.write(
        `Requesting proof from ${presenterDid.slice(0, 24)}…\n` +
          `  trusting issuer ${issuerDid.slice(0, 24)}…\n` +
          (Object.keys(requiredClaims).length ? `  requiring ${JSON.stringify(requiredClaims)}\n` : ''),
      );

      const challengeDid = await requestProof(handle, { schema: schemaDid, trustedIssuers: [issuerDid] });
      const reply = await transport.request(presenterDid, {
        type: 'hearthold/proof-request',
        version: PROTOCOL_VERSION,
        challengeDid,
        schema: schemaDid,
      });

      if (reply.type === 'hearthold/error') {
        process.stdout.write(`\n✗ ${reply.reason}\n`);
        process.exitCode = 1;
        break;
      }
      if (reply.type !== 'hearthold/proof-presentation') {
        process.stderr.write(`unexpected reply: ${reply.type}\n`);
        process.exitCode = 1;
        break;
      }

      const presentation = reply as ProofPresentationMessage;
      const result = await verifyProof(handle, presentation.responseDid, {
        trustedIssuers: [issuerDid],
        requiredClaims: Object.keys(requiredClaims).length ? requiredClaims : undefined,
      });

      if (presentation.humanProof) {
        const p = presentation.humanProof;
        process.stdout.write(`  approved by the Sovereign (${p.method}, level ${p.level})\n`);
      }

      if (result.ok) {
        process.stdout.write(`\n✓ VERIFIED\n`);
        for (const d of result.disclosed) {
          process.stdout.write(
            `  ${JSON.stringify(d.claims)}\n  ↳ issued by ${d.issuer.slice(0, 32)}… (trusted)\n`,
          );
        }
      } else {
        process.stdout.write(`\n✗ NOT VERIFIED: ${result.reason}\n`);
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
  process.stderr.write(`verifier: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
