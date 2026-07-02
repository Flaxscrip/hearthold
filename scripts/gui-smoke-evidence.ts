/**
 * Evidence step-up smoke — the Witness sends ONE evidence-request to a running `warden control`
 * daemon and waits. Internally the Warden gets the Sovereign's approval on its own channel (the
 * Signet shows the Warden's description); the Witness never sees the approval, just the result.
 *
 * Env: HEARTHOLD_PASSPHRASE (witness), WARDEN_DID, SUBJECT_DID (the Sovereign). Run after the daemons.
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
} from '@hearthold/core';

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE;
  const wardenDid = process.env.WARDEN_DID;
  const subjectDid = process.env.SUBJECT_DID;
  if (!pass || !wardenDid || !subjectDid) throw new Error('need HEARTHOLD_PASSPHRASE, WARDEN_DID, SUBJECT_DID');

  const witness = await openKeymaster('witness', config, pass);
  await ensureIdentity(witness, config);
  const transport = new DidCommTransport(witness, IDENTITY_NAME.witness, config.nodeUrl);
  await transport.ready();

  process.stdout.write('WITNESS → evidence-request (MEDIUM location claim) … awaiting the Warden\n');
  const reply = await transport.request(
    wardenDid,
    {
      type: 'hearthold/evidence-request',
      version: PROTOCOL_VERSION,
      claim: 'Resided in FR during 2026-H1',
      disclosureMode: 'ATTESTATION',
      subjectDid,
      spec: { kind: 'location', from: '2026-01-01', to: '2026-06-30', structured: { type: 'residence', country: 'FR' } },
    },
    { timeoutMs: 180_000 },
  );

  if (reply.type === 'hearthold/evidence-response' && reply.status === 'granted') {
    process.stdout.write(`WITNESS ← ✓ granted evidence graph: ${reply.credentialDid}\n`);
  } else if (reply.type === 'hearthold/evidence-response') {
    process.stdout.write(`WITNESS ← ${reply.status}: ${JSON.stringify(reply)}\n`);
  } else {
    process.stdout.write(`WITNESS ← unexpected ${reply.type}\n`);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`gui-smoke-evidence: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
