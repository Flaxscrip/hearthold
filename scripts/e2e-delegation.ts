/**
 * End-to-end test of the Hearthold delegation handshake against a live Archon node.
 *
 *   provision Warden + Witness  →  register schema  →  [negative: respond w/o delegation]
 *   →  issue delegation  →  Witness accepts  →  [positive: respond + verify]
 *   →  Warden revokes  →  [negative: verify fails]
 *
 * Runs both agents in-process with separate wallets (separate data folders), mirroring the real
 * two-wallet separation. Isolated under .hearthold-e2e so it never touches ~/.hearthold.
 *
 * Run:  npm run e2e
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureDelegationSchema,
  issueDelegation,
  acceptDelegation,
  revokeCredential,
  createDelegationChallenge,
  respondToChallenge,
  verifyChallengeResponse,
} from '@hearthold/core';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';

let failures = 0;
function check(label: string, ok: boolean): void {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
}

function step(msg: string): void {
  process.stdout.write(`\n▸ ${msg}\n`);
}

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(
    `Hearthold delegation e2e\n  gatekeeper: ${config.gatekeeperUrl}\n` +
      `  registry:   ${config.registry}\n  data:       ${DATA_ROOT}\n`,
  );

  step('Provision identities');
  const warden = await openKeymaster('warden', config, PASSPHRASE);
  const witness = await openKeymaster('witness', config, PASSPHRASE);
  const wardenId = await ensureIdentity(warden, config);
  const witnessId = await ensureIdentity(witness, config);
  check(`warden did  ${wardenId.did.slice(0, 32)}…`, wardenId.did.startsWith('did:'));
  check(`witness did ${witnessId.did.slice(0, 32)}…`, witnessId.did.startsWith('did:'));

  step('Register delegation schema');
  const schemaDid = await ensureDelegationSchema(warden);
  check(`schema did  ${schemaDid.slice(0, 32)}…`, schemaDid.startsWith('did:'));

  step('Negative: Witness responds before holding any delegation');
  const challenge1 = await createDelegationChallenge(warden, schemaDid);
  const response1 = await respondToChallenge(witness, challenge1);
  const verify1 = await verifyChallengeResponse(warden, response1);
  check('unauthorized response is rejected', verify1.verified === false);
  check(`  (requested ${verify1.requested}, fulfilled ${verify1.fulfilled})`, true);

  step('Issue delegation → Witness accepts');
  const validUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  const delegationDid = await issueDelegation(warden, witnessId.did, schemaDid, {
    kinds: ['event', 'location', 'activity'],
    validUntil,
  });
  check(`delegation  ${delegationDid.slice(0, 32)}…`, delegationDid.startsWith('did:'));
  const accepted = await acceptDelegation(witness, delegationDid);
  check('witness accepted delegation', accepted === true);

  step('Positive: Witness responds with delegation held');
  const challenge2 = await createDelegationChallenge(warden, schemaDid);
  const response2 = await respondToChallenge(witness, challenge2);
  const verify2 = await verifyChallengeResponse(warden, response2);
  check('authorized response verifies', verify2.verified === true);
  check(`responder is the witness`, verify2.responderDid === witnessId.did);
  check(`  (requested ${verify2.requested}, fulfilled ${verify2.fulfilled})`, true);

  step('Revoke delegation → response no longer verifies');
  const revoked = await revokeCredential(warden, delegationDid);
  check('delegation revoked', revoked === true);
  const challenge3 = await createDelegationChallenge(warden, schemaDid);
  const response3 = await respondToChallenge(witness, challenge3);
  const verify3 = await verifyChallengeResponse(warden, response3);
  check('revoked delegation is rejected', verify3.verified === false);

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ne2e error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
