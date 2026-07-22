#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  openKeymasterFresh,
  ensureIdentity,
  acceptCredential,
  recordIssuedCredential,
  agentDataFolder,
  IssuedStore,
  DidCommTransport,
  IDENTITY_NAME,
  ensureSchema,
  openSchema,
  issueClaim,
  signKbRequest,
  PROTOCOL_VERSION,
  type KbRequestStatement,
} from '@hearthold/core';

import { makeSovereignHandler } from './handler.js';
import { PromptGate } from './signet.js';
import { runSovereignControl } from './control.js';

const HELP = `Hearthold Sovereign — the principal (Signet precursor)

Usage:
  sovereign init             Provision the Sovereign identity + publish its DIDComm endpoint
  sovereign status           Show identity and config
  sovereign accept <credDid> Accept a third-party credential and record it in the vault
  sovereign issued           List the issued (third-party) credentials in the vault
  sovereign issue <subjectDid> <type> [key=value ...]
                             Issue a credential to a subject (act as an issuer, e.g. a guild manager)
  sovereign serve            Serve over DIDComm: present proofs on request (terminal PIN)
  sovereign control [port]   Serve DIDComm + a control API for the Signet Approver app (default 4311)
  sovereign kb-query <mageDid> <kbId> <query>          Ask a Knowledge Base (via its public Mage portal)
  sovereign kb-update <mageDid> <kbId> <kind> <text>   Contribute knowledge to a KB (if authorized)
  sovereign help             Show this message

Env:
  HEARTHOLD_PASSPHRASE   wallet passphrase (required)
  HEARTHOLD_NODE_URL     Archon node (Drawbridge) URL; default http://flaxlap.local:4222
  HEARTHOLD_DATA_ROOT    default ~/.hearthold
  HEARTHOLD_SIGNET_PIN   Signet PIN that gates each disclosure (required for serve)
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

  // Re-open a fresh sovereign handle on demand: a new keymaster reads wallet.json from disk with an empty
  // cache, so a long-lived `serve`/`control` daemon sees a credential accepted by a separate `sovereign
  // accept` process without a restart. The handler uses it for EVERY request (not just present), so no
  // operation reads or writes through a stale cache (reload-before-write guard). `openKeymasterFresh`
  // forces the read + retries a torn read (accept's non-atomic write), failing closed.
  const reopenSovereign = (): Promise<typeof handle> => openKeymasterFresh('sovereign', config, passphrase);

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
      if (!config.signetPin) {
        throw new Error('HEARTHOLD_SIGNET_PIN is required to serve — it gates each disclosure');
      }
      const gate = new PromptGate(config.signetPin);
      const transport = new DidCommTransport(handle, IDENTITY_NAME.sovereign, config.nodeUrl);
      await transport.ready();
      const stop = await transport.serve(makeSovereignHandler(handle, gate, reopenSovereign));
      process.stdout.write(
        `Sovereign serving over DIDComm (Signet PIN approval on each disclosure)\n  did: ${id.did}\n  (Ctrl-C to stop)\n`,
      );
      const shutdown = (): void => {
        stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'control': {
      const port = Number(process.argv[3] ?? process.env.HEARTHOLD_CONTROL_PORT ?? 4311);
      await runSovereignControl(handle, config, port, reopenSovereign);
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
    case 'issue': {
      const subjectDid = process.argv[3];
      const type = process.argv[4];
      if (!subjectDid || !type) {
        throw new Error('usage: sovereign issue <subjectDid> <type> [key=value ...]');
      }
      const claims: Record<string, unknown> = { type };
      for (const kv of process.argv.slice(5)) {
        const eq = kv.indexOf('=');
        if (eq > 0) claims[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      const schemaDid = await ensureSchema(handle, type, openSchema(type));
      const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
      const credDid = await issueClaim(handle, subjectDid, schemaDid, claims, validUntil);
      process.stdout.write(
        `Issued ${type} to ${subjectDid.slice(0, 28)}…\n` +
          `  claims:     ${JSON.stringify(claims)}\n` +
          `  credential: ${credDid}\n` +
          `  schema:     ${schemaDid}\n` +
          `  → subject runs:  sovereign accept ${credDid}\n` +
          `  → verifier uses: <schema>=${schemaDid} <issuer>=${id.did}\n`,
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
    case 'kb-query':
    case 'kb-update': {
      const mageDid = process.argv[3];
      const kbId = process.argv[4];
      if (!mageDid || !kbId) throw new Error(`usage: sovereign ${cmd} <mageDid> <kbId> …`);
      const transport = new DidCommTransport(handle, IDENTITY_NAME.sovereign, config.nodeUrl);
      await transport.ready();

      // 1. Get a fresh challenge nonce from the KB (relayed by the Mage).
      const chReply = await transport.request(mageDid, {
        type: 'hearthold/kb-challenge-request',
        version: PROTOCOL_VERSION,
        kbId,
      });
      if (chReply.type !== 'hearthold/kb-challenge') {
        throw new Error(`no challenge: ${JSON.stringify(chReply)}`);
      }
      const nonce = chReply.nonce;

      // 2. Sign the request over the nonce (proves DID control end-to-end), send via the Mage.
      const statement: KbRequestStatement =
        cmd === 'kb-query'
          ? { action: 'query', requester: id.did, kbId, nonce, query: process.argv.slice(5).join(' ') }
          : { action: 'update', requester: id.did, kbId, nonce, kind: process.argv[5], text: process.argv.slice(6).join(' ') };
      const request = await signKbRequest(handle, statement);
      const reply = await transport.request(mageDid, { type: 'hearthold/kb-request', version: PROTOCOL_VERSION, request });

      if (reply.type === 'hearthold/kb-error') {
        process.stderr.write(`KB refused: ${reply.reason}\n`);
        process.exitCode = 1;
      } else if (reply.type === 'hearthold/kb-result' && reply.action === 'query') {
        process.stdout.write(`\n🔎 ${reply.answer}\n`);
        for (const c of reply.citations) {
          process.stdout.write(`   · [${c.kind}] ${c.observedAt} (${c.score.toFixed(2)})\n`);
        }
      } else if (reply.type === 'hearthold/kb-result' && reply.action === 'update') {
        process.stdout.write(`✓ contributed to the KB · ${reply.artefactId.slice(0, 28)}…\n`);
      }
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
