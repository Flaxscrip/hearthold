/**
 * GUI smoke helper — acts as a verifier that sends a single proof-request to a target DID (a running
 * `sovereign control` daemon) so the Signet's HttpGate parks a pending approval. Used only to exercise
 * the Signet Approver flow; not part of the product.
 *
 * Env: HEARTHOLD_PASSPHRASE, TARGET_DID (the Sovereign), plus the usual HEARTHOLD_* config.
 * Run:  node --experimental-strip-types scripts/gui-smoke-verifier.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureSchema,
  openSchema,
  requestProof,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
} from '@hearthold/core';

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE;
  const target = process.env.TARGET_DID;
  if (!pass || !target) throw new Error('HEARTHOLD_PASSPHRASE and TARGET_DID are required');

  const handle = await openKeymaster('verifier', config, pass);
  await ensureIdentity(handle, config);
  const transport = new DidCommTransport(handle, IDENTITY_NAME.verifier, config.nodeUrl);
  await transport.ready();

  const schema = await ensureSchema(handle, 'GuiSmokeClaim', openSchema('GuiSmokeClaim'));
  const challengeDid = await requestProof(handle, { schema });
  const msg = {
    type: 'hearthold/proof-request' as const,
    version: PROTOCOL_VERSION,
    challengeDid,
    schema,
  };
  process.stdout.write(`VERIFIER → proof-request to ${target.slice(0, 22)}…\n`);
  try {
    const reply = await transport.request(target, msg, { timeoutMs: 60_000 });
    process.stdout.write(`VERIFIER ← ${reply.type} ${(reply as { reason?: string }).reason ?? ''}\n`);
  } catch (e) {
    process.stdout.write(`VERIFIER ← ${e instanceof Error ? e.message : String(e)}\n`);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`gui-smoke-verifier: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
