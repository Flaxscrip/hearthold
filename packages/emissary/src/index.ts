#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import {
  loadConfig,
  openKeymaster,
  passphraseFor,
  runKeyMaintenance,
  ensureIdentity,
  acceptDelegation,
  sealForWarden,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
  revokeStatusIndex,
  type WitnessSubmission,
  type Sensitivity,
  type WitnessKind,
} from '@hearthold/core';

import { makeEmissaryProjectorHandler } from './handler.js';
import { makeKbRelayHandler } from './kb-relay.js';
import { startKbPortalServer } from './kb-portal-server.js';
import { runEmissaryControl } from './control.js';
import { invokeEvidence } from './invoke.js';
import { HeldChainStore, delegateHeldOnward, chainInvokeEvidence, transferChainGrant, reportHopRegistered, reportHopRevoked } from './chain.js';

const HELP = `Hearthold Emissary — Companion

Usage:
  emissary init                 Provision the Emissary identity + publish its DIDComm endpoint
  emissary status               Show identity and config
  emissary accept <credDid>     Accept a delegation credential from the Warden
  emissary submit <kind> <text> Seal an observation and submit it to the Warden over DIDComm
  emissary submit-image <path>  Submit an image; the Warden captions it on-device, then classifies
  emissary invoke <claim...> [kind=location] [target=…]
                                Present the scope capability to PROVE a fact — the Warden mints a signed
                                evidence graph (sensitive claims step up to the Signet)
  emissary serve                Project to the world: relay proof-requests to the Sovereign (Signet)
  emissary kb-portal            Emissary: relay Knowledge Base traffic to the Warden (carries only)
  emissary kb-web [port]        Emissary web portal: HTTP→DIDComm bridge for the browser (default 4313)
  emissary control [port]       Submit + project over DIDComm, with a control API for the Emissary app (default 4312)
  emissary republish [--endpoint <uri>]  Force-(re)publish the DIDComm endpoint (re-home)
  emissary rotate               Rotate signing keys (incident response)
  emissary passphrase <new>     Re-encrypt the wallet under a new passphrase
  emissary check                Health-check the wallet
  emissary help                 Show this message

  <kind> ∈ event | location | activity | browsing | document

Env:
  HEARTHOLD_PASSPHRASE     wallet passphrase — shared or per-role _EMISSARY (required)
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
  const passphrase = passphraseFor('emissary');

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
          `Submitted ${kind} to Warden ${wardenDid.slice(0, 24)}… — received & queued for review\n` +
            `  artefact:    ${reply.artefactId.slice(0, 28)}…\n` +
            `  status:      ${reply.queued ? 'classifying in the background; born-obsidian in triage until you confirm' : `sensitivity ${reply.assignedSensitivity}`}\n`,
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
    case 'submit-image': {
      const path = process.argv[3];
      if (!path) throw new Error('usage: emissary submit-image <path-to-image>');
      const wardenDid = config.wardenDid;
      if (!wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is required for submit');
      const bytes = readFileSync(path);
      // Size cap: the image rides in the sealed submission payload over DIDComm. Keep it modest.
      const MAX_BYTES = 8 * 1024 * 1024;
      if (bytes.length > MAX_BYTES) throw new Error(`image too large (${bytes.length} bytes > ${MAX_BYTES}); cap is 8 MB`);
      const ext = (path.split('.').pop() ?? '').toLowerCase();
      const mediaType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

      const transport = new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl);
      await transport.ready();
      // Store the bytes as a NATIVE Archon image asset (→ the node's content-addressed IPFS), and ship only
      // the tiny asset-DID REFERENCE — no 8 MB of base64 in DIDComm. The Warden resolves it (get-image) and
      // captions it with the local vision model. The asset DID is sealed to the Warden (kept private).
      // Born LOCAL by default (privacy by construction; no hyperswarm never-confirms stall) — explicit here
      // even though the keymaster default is already contentRegistry, because Aegis named this op.
      const assetDid = await handle.keymaster.createImage(bytes, { registry: config.contentRegistry });
      const ciphertext = await sealForWarden(handle, wardenDid, JSON.stringify({ assetDid, mediaType }));
      const submission: WitnessSubmission = {
        type: 'hearthold/witness-submission',
        version: PROTOCOL_VERSION,
        kind: 'image',
        observedAt: new Date().toISOString(),
        ciphertext,
      };
      const reply = await transport.request(wardenDid, submission);
      if (reply.type === 'hearthold/submission-receipt') {
        process.stdout.write(
          `Submitted image to Warden ${wardenDid.slice(0, 24)}… — received & queued for review\n` +
            `  artefact:    ${reply.artefactId.slice(0, 28)}…\n` +
            `  status:      captioning on-device in the background; born-obsidian in triage until you confirm\n`,
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
    case 'invoke': {
      const claim = process.argv.slice(3).filter((a) => !a.includes('=')).join(' ');
      const opts: Record<string, string> = {};
      for (const kv of process.argv.slice(3).filter((a) => a.includes('='))) {
        const eq = kv.indexOf('=');
        if (eq > 0) opts[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      if (!claim) throw new Error('usage: emissary invoke <claim...> [kind=location] [target=hearthold:vault:location]');
      const kind = opts.kind ?? 'location';
      const wardenDid = config.wardenDid;
      if (!wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is required for invoke');

      const transport = new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl);
      await transport.ready();
      const reply = await invokeEvidence(handle, transport, wardenDid, { claim, kind, ...(opts.target ? { target: opts.target } : {}) });

      if (reply.type === 'hearthold/evidence-response' && reply.status === 'granted') {
        // Accept the minted evidence graph so the Emissary can present it to a verifier.
        if (reply.credentialDid) await handle.keymaster.acceptCredential(reply.credentialDid).catch(() => undefined);
        process.stdout.write(
          `✓ Invocation GRANTED — the Warden minted a signed evidence graph\n` +
            `  claim:      ${reply.graph?.claim ?? claim}\n` +
            `  trustClass: ${reply.graph?.trustClass ?? 'witnessed'}\n` +
            `  credential: ${reply.credentialDid}\n` +
            `  schema:     ${reply.schemaDid}\n` +
            `  → a verifier checks it: verifier verify ${id.did} ${reply.schemaDid} ${wardenDid}\n`,
        );
      } else if (reply.type === 'hearthold/evidence-response') {
        process.stderr.write(`✗ Invocation denied: ${reply.reason}\n`);
        process.exitCode = 1;
      } else {
        process.stderr.write(`✗ ${reply.reason}\n`);
        process.exitCode = 1;
      }
      break;
    }
    case 'delegate-capability': {
      const holderDid = process.argv[3];
      if (!holderDid || holderDid.includes('=')) throw new Error('usage: emissary delegate-capability <holderDid> [ceiling=LOW] [kinds=location,book] [target=…] [leaf=<vcDid>]');
      const opts: Record<string, string> = {};
      for (const kv of process.argv.slice(4).filter((a) => a.includes('='))) { const eq = kv.indexOf('='); opts[kv.slice(0, eq)] = kv.slice(eq + 1); }
      const CEIL: Record<string, number> = { PUBLIC: 0, LOW: 1, MEDIUM: 2, HIGH: 3, SEALED: 4 };
      const ceiling = opts.ceiling ? CEIL[opts.ceiling.toUpperCase()] : undefined;
      if (opts.ceiling && ceiling === undefined) throw new Error(`unknown ceiling '${opts.ceiling}' — PUBLIC|LOW|MEDIUM|HIGH|SEALED`);
      const kinds = opts.kinds ? (opts.kinds.split(',').map((s) => s.trim()).filter(Boolean) as WitnessKind[]) : undefined;
      const held = new HeldChainStore(handle.dataFolder);
      const { grant, issued } = await delegateHeldOnward({
        issuer: handle, issuerName: id.name, config, held, holderDid,
        ...(ceiling !== undefined ? { ceiling: ceiling as Sensitivity } : {}),
        ...(kinds ? { kinds } : {}),
        ...(opts.target ? { target: opts.target } : {}),
        ...(opts.leaf ? { leafVcDid: opts.leaf } : {}),
      });
      await held.putIssued(issued);
      const transport = new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl);
      await transport.ready();
      await transferChainGrant(handle, id.name, holderDid, grant);
      if (config.sovereignDid) {
        await reportHopRegistered(handle, id.name, config.sovereignDid, { childVcDid: issued.childVcDid, parentVcDid: grant.handle.capability.parentCapability ?? '', holder: holderDid, counter: grant.handle.issued.counter }).catch(() => undefined);
      }
      process.stdout.write(`✓ Delegated an attenuated child hop to ${holderDid.slice(0, 32)}…\n  child: ${issued.childVcDid}\n  → cut it later:  emissary revoke-hop ${issued.childVcDid}\n`);
      break;
    }
    case 'chain-invoke': {
      const claim = process.argv.slice(3).filter((a) => !a.includes('=')).join(' ');
      const opts: Record<string, string> = {};
      for (const kv of process.argv.slice(3).filter((a) => a.includes('='))) { const eq = kv.indexOf('='); opts[kv.slice(0, eq)] = kv.slice(eq + 1); }
      if (!claim) throw new Error('usage: emissary chain-invoke <claim…> [kind=location] [leaf=<vcDid>]');
      const wardenDid = config.wardenDid;
      if (!wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is required for chain-invoke');
      const held = new HeldChainStore(handle.dataFolder);
      const grant = opts.leaf ? await held.get(opts.leaf) : await held.latest();
      if (!grant) throw new Error('this Emissary holds no chain capability to present (get one via delegate-capability or a Sovereign mint-root)');
      const transport = new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl);
      await transport.ready();
      const reply = await chainInvokeEvidence(handle, id.name, transport, wardenDid, grant, { claim, kind: opts.kind ?? 'location' });
      if (reply.type === 'hearthold/evidence-response' && reply.status === 'granted') {
        if (reply.credentialDid) await handle.keymaster.acceptCredential(reply.credentialDid).catch(() => undefined);
        process.stdout.write(`✓ Chain invocation GRANTED\n  claim:      ${reply.graph?.claim ?? claim}\n  credential: ${reply.credentialDid}\n  schema:     ${reply.schemaDid}\n`);
      } else {
        process.stderr.write(`✗ Chain invocation denied: ${reply.reason}\n`);
        process.exitCode = 1;
      }
      break;
    }
    case 'revoke-hop': {
      const childVcDid = process.argv[3];
      if (!childVcDid) throw new Error('usage: emissary revoke-hop <childVcDid>');
      const held = new HeldChainStore(handle.dataFolder);
      const hop = await held.getIssued(childVcDid);
      if (!hop) throw new Error('no issued hop with that childVcDid — this Emissary did not delegate it');
      await revokeStatusIndex(handle, id.name, hop.statusListCredential, hop.statusListIndex);
      if (config.sovereignDid) await reportHopRevoked(handle, id.name, config.sovereignDid, childVcDid).catch(() => undefined);
      process.stdout.write(`✓ Revoked the hop delegated to ${hop.holder.slice(0, 32)}… — the delegate's chain is denied at its next invocation\n`);
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
      // Anonymous (no-wallet) public query: set HEARTHOLD_ORACLE_KB to the KB to answer. The Emissary's own
      // read-only identity serves as the oracle reader — it open-enrolls as a read member on first ask and
      // holds NO write authority over the shared chronicle (that stays with the curators' writeGroup).
      const oracleKb = process.env.HEARTHOLD_ORACLE_KB?.trim();
      const numEnv = (v: string | undefined): number | undefined => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const oracle = oracleKb
        ? {
            createResponse: (challenge: string, opts?: { registry?: string }): Promise<string> =>
              handle.keymaster.createResponse(challenge, opts),
            kbId: oracleKb,
            registry: config.registry,
            perIpPerMin: numEnv(process.env.HEARTHOLD_ORACLE_PER_IP_PER_MIN),
            maxConcurrent: numEnv(process.env.HEARTHOLD_ORACLE_MAX_CONCURRENT),
          }
        : undefined;
      // Extra CORS origins (e.g. the Signet wallet on its own origin, whose login-callback POST would
      // otherwise be refused). Comma-separated absolute origins; empty ⇒ the portal's own origin only.
      const allowOrigins = (process.env.HEARTHOLD_PORTAL_ALLOW_ORIGIN ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      const server = startKbPortalServer({ transport, wardenDid, port, host, publicUrl, allowOrigins, oracle });
      const shutdown = (): void => {
        server.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'republish': {
      // Force-(re)publish the Emissary's DIDComm endpoint after first boot — re-home onto a new reachable
      // address (Tor onion / tailnet / migrated host). `--endpoint <uri>` overrides the env/node default.
      await ensureIdentity(handle, config);
      const ei = process.argv.indexOf('--endpoint');
      const endpoint = ei > 0 ? process.argv[ei + 1] : undefined;
      const { endpoint: pub, previous } = await new DidCommTransport(handle, IDENTITY_NAME.emissary, config.nodeUrl).republish(endpoint);
      process.stdout.write(`Emissary DIDComm endpoint republished\n${previous ? `  was: ${previous}\n` : ''}  now: ${pub}\n`);
      break;
    }
    case 'rotate':
    case 'passphrase':
    case 'check': {
      // Incident response (L1): rotate signing keys, re-encrypt the wallet, or health-check it.
      if (cmd === 'rotate') await ensureIdentity(handle, config);
      const result = await runKeyMaintenance(handle, cmd, process.argv[3]);
      process.stdout.write(`${result}\n`);
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
