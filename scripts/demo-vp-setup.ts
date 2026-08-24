/**
 * VP demo setup — provisions a self-contained `issued`-credential prove flow so you can watch a
 * Verifiable Presentation get produced and approved in the Signet Approver GUI.
 *
 * Uses throwaway wallets under a dedicated data root (default ~/.hearthold-vpdemo), so none of your
 * real Hearthold wallets or passphrases are touched. It creates:
 *   - a sphere "issuer"  (a trusted third-party issuer)
 *   - the Sovereign     (the holder / Signet)
 *   - a SphereMembership credential issued to the Sovereign, which the Sovereign accepts
 *
 * Then it prints the two commands to run: the Signet daemon, and the verifier request.
 *
 * Run:  HEARTHOLD_DATA_ROOT=~/.hearthold-vpdemo npm run demo:vp-setup
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureSchema,
  openSchema,
  issueClaim,
  acceptCredential,
  DidCommTransport,
  IDENTITY_NAME,
} from '@hearthold/core';

const SOV_PASS = 'demo-sov';
const ISSUER_PASS = 'demo-issuer';
const VERIFIER_PASS = 'demo-verifier';
const WITNESS_PASS = 'demo-witness';
const PIN = '1234';

async function main(): Promise<void> {
  const config = loadConfig();

  // Sphere issuer (a trusted third party) — parked in the 'warden' wallet slot of the demo root.
  const issuer = await openKeymaster('warden', config, ISSUER_PASS);
  const issuerId = await ensureIdentity(issuer, config);

  // The Sovereign — the holder the verifier will ask, gated by the Signet.
  const sovereign = await openKeymaster('sovereign', config, SOV_PASS);
  const sovId = await ensureIdentity(sovereign, config);

  const type = 'SphereMembership';
  const schemaDid = await ensureSchema(issuer, type, openSchema(type));
  const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const credDid = await issueClaim(
    issuer,
    sovId.did,
    schemaDid,
    { type, sphere: 'Drake Gamers Guild', role: 'Raid-Lead' },
    validUntil,
  );
  const accepted = await acceptCredential(sovereign, credDid);
  if (!accepted) throw new Error('the Sovereign failed to accept the credential');

  // The Emissary projector — carries proofs and relays disclosures to the Signet (projected flow).
  const witness = await openKeymaster('emissary', config, WITNESS_PASS);
  const witnessId = await ensureIdentity(witness, config);
  await new DidCommTransport(witness, IDENTITY_NAME.emissary, config.nodeUrl).ready();

  const line = '─'.repeat(64);
  process.stdout.write(
    `\n${line}\n  VP demo ready — the Sovereign holds a SphereMembership from the sphere\n${line}\n` +
      `  Sovereign (holder) : ${sovId.did}\n` +
      `  Emissary (projector): ${witnessId.did}\n` +
      `  Issuer (sphere)     : ${issuerId.did}\n` +
      `  Schema             : ${schemaDid}\n` +
      `  Credential         : ${credDid}\n${line}\n\n` +
      `Common — start these two first (SAME data root):\n\n` +
      `  # the Signet daemon (backs the Signet Approver GUI)\n` +
      `  HEARTHOLD_DATA_ROOT="${config.dataRoot}" HEARTHOLD_PASSPHRASE=${SOV_PASS} ` +
      `HEARTHOLD_SIGNET_PIN=${PIN} npm run sovereign -- control\n\n` +
      `  # the Signet Approver app (approve in the browser with PIN ${PIN})\n` +
      `  cd apps/signet-approver && npm run dev            # → http://localhost:5174\n\n` +
      `A) DIRECT flow — the verifier asks the Sovereign itself:\n\n` +
      `  HEARTHOLD_DATA_ROOT="${config.dataRoot}" HEARTHOLD_PASSPHRASE=${VERIFIER_PASS} ` +
      `npm run verifier -- verify ${sovId.did} ${schemaDid} ${issuerId.did}\n\n` +
      `B) PROJECTED flow — the verifier asks the Emissary, which relays to the Signet:\n\n` +
      `  # the Emissary projector (note HEARTHOLD_SOVEREIGN_DID — that is what enables projection)\n` +
      `  HEARTHOLD_DATA_ROOT="${config.dataRoot}" HEARTHOLD_PASSPHRASE=${WITNESS_PASS} ` +
      `HEARTHOLD_SOVEREIGN_DID=${sovId.did} npm run witness -- control 4313\n\n` +
      `  # the Emissary app (watch its Projections panel) — point it at the projector daemon\n` +
      `  cd apps/witness && VITE_CONTROL_URL=http://127.0.0.1:4313 npm run dev\n\n` +
      `  # the verifier now addresses the WITNESS, not the Sovereign\n` +
      `  HEARTHOLD_DATA_ROOT="${config.dataRoot}" HEARTHOLD_PASSPHRASE=${VERIFIER_PASS} ` +
      `npm run verifier -- verify ${witnessId.did} ${schemaDid} ${issuerId.did}\n\n`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`demo-vp-setup: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
