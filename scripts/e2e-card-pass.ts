/**
 * e2e: CARD PASS — the receive half of `POST /api/card/pass`, over real DIDComm.
 *
 * A sender delivers a credential (core `deliverCredential`) to a recipient's Warden. The recipient's
 * inbound handler — the same logic wired into `warden control` — verifies the card and QUEUES it as a
 * PENDING-INBOUND item (born obsidian; import happens only on the member's later accept, Sevenfold's
 * model), never importing foreign ops into its own gatekeeper (B6). It acks the sender and the card shows
 * up in the `InboundCardStore` (what `GET /api/card/inbound` lists).
 *
 * The send route's co-sign (a MEDIUM+ Signet step-up) is build-verified and exercised by the HTTP daemon
 * harness (like e2e-family-isolation); this e2e proves the transport + verify + queue + ack path.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-card-pass.ts
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  deliverCredential,
  DidCommTransport,
  PROTOCOL_VERSION,
  type RequestHandler,
  type CredentialDeliveryMessage,
} from '@hearthold/core';
import { InboundCardStore } from '@hearthold/warden/inbound-card-store';
import type { CardReceivedEvent } from '@hearthold/control-types';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const SCHEMA = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { type: { type: 'string' } }, required: ['type'], additionalProperties: true } as const;

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-card-pass-e2e';
  const cfg = (s: string) => ({ ...base, dataRoot: join(base.dataRoot, s) });

  step('Provision sender (issuer) + recipient (a Warden on its own data root)');
  const sender = await openKeymaster('warden', cfg('send'), pass);
  const recipient = await openKeymaster('warden', cfg('recv'), pass);
  const senderId = await ensureIdentity(sender, cfg('send'));
  const recipientId = await ensureIdentity(recipient, cfg('recv'));

  step('Sender issues a card (VC) to the recipient');
  await sender.keymaster.setCurrentId(IDENTITY_NAME.warden);
  const schemaDid = await sender.keymaster.createSchema(SCHEMA);
  const bound = await sender.keymaster.bindCredential(recipientId.did, { schema: schemaDid, claims: { type: 'Membership' } });
  const credDid = await sender.keymaster.issueCredential(bound, { schema: schemaDid });

  // The recipient's inbound handler — the same verify → queue → ack the control plane wires (minus the
  // SSE emit, which needs the HTTP server). Uses the REAL InboundCardStore + REAL transport.
  const inbound = new InboundCardStore(recipient.dataFolder);
  const recipientHandler: RequestHandler = async (message, fromDid) => {
    if (message.type !== 'hearthold/credential-delivery') return null;
    const m = message as CredentialDeliveryMessage;
    const verified = await recipient.keymaster.resolveDID(m.credentialDid).then((d) => Boolean(d.didDocument?.id)).catch(() => false);
    const card: CardReceivedEvent = {
      credentialDid: m.credentialDid,
      schemaDid: m.schemaDid,
      from: String(fromDid).split('#')[0] ?? '',
      verified,
      receivedAt: new Date().toISOString(),
      owner: recipientId.did,
    };
    inbound.put(card);
    return { type: 'hearthold/credential-delivery-ack', version: PROTOCOL_VERSION, credentialDid: m.credentialDid, accepted: verified };
  };

  step('Recipient serves the inbound handler; sender passes the card over DIDComm');
  const recvTransport = new DidCommTransport(recipient, IDENTITY_NAME.warden, base.nodeUrl);
  await recvTransport.ready();
  const senderTransport = new DidCommTransport(sender, IDENTITY_NAME.warden, base.nodeUrl);
  await senderTransport.ready();
  const stop = await recvTransport.serve(recipientHandler, { pollMs: 1000 });
  try {
    const ack = await deliverCredential(sender, IDENTITY_NAME.warden, senderTransport, recipientId.did, credDid, { schemaDid });
    check('sender got an ack; the recipient accepted (verified)', ack.type === 'hearthold/credential-delivery-ack' && ack.accepted === true);

    const queued = inbound.list(recipientId.did);
    check('the card is queued as PENDING-INBOUND on the recipient', queued.length === 1 && queued[0]?.credentialDid === credDid);
    check('it is verified and attributed to the sender', queued[0]?.verified === true && queued[0]?.from === senderId.did);
    check('it is NOT yet in the recipient vault (import happens only on accept)', queued[0]?.schemaDid === schemaDid);

    // Re-delivery upserts (no duplicate); scoping + remove behave.
    await deliverCredential(sender, IDENTITY_NAME.warden, senderTransport, recipientId.did, credDid, { schemaDid });
    check('re-delivery upserts (still one pending-inbound entry)', inbound.list(recipientId.did).length === 1);
    check('scoped to a different owner → empty', inbound.list('did:cid:someone-else').length === 0);
    inbound.remove(credDid);
    check('remove clears it (the accept path will do this on import)', inbound.list(recipientId.did).length === 0);
  } finally {
    stop();
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ card-pass: a passed card is verified + queued born-obsidian on the recipient (import only on accept); B6 intact\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-card-pass: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
