/**
 * e2e: VC → KB bridge — a 3rd-party credential becomes private-from-the-Warden knowledge (financial theme).
 *
 * A bank issues an AccreditedInvestor credential to the Sovereign; the Sovereign accepts it; the Warden
 * then ingests it into the Sovereign's PRIVATE member-key KB partition. The rendered fact is sealed to
 * the partition's public key — the Warden write-hosts it but CANNOT read it at rest; only the Sovereign's
 * (session-rewrapped) partition key reads it back. The artefact stays linked to the signed credential, so
 * trust remains with the ISSUER (still presentable / composable as an `issued` leaf).
 *
 * Turns "I hold a bank's VC" into "my Hearthold privately knows I'm accredited" — recallable to me,
 * opaque to the custodian at rest, still provable with the bank's own attestation.
 *
 * Isolated data root; run:  npm run e2e:finance-vault
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureSchema,
  openSchema,
  issueClaim,
  acceptCredential,
  recordIssuedCredential,
  unsealAsWarden,
  openWithKey,
  unwrapKey,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { PartitionStore } from '@hearthold/warden/partition-store';
import { ingestCredentialToPartition } from '@hearthold/warden/credential-vault';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  process.stdout.write(`  ✓ ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-finance-vault';
  const SPACE = 'sovereign-wallet-kb';

  const warden = await openKeymaster('warden', config, pass);
  const sovereign = await openKeymaster('sovereign', config, pass);
  const bank = await openKeymaster('verifier', config, pass); // "Meridian Capital"
  await ensureIdentity(warden, config);
  const sovId = await ensureIdentity(sovereign, config);
  const bankId = await ensureIdentity(bank, config);

  process.stdout.write('\n▸ Bank issues AccreditedInvestor → the Sovereign accepts it\n');
  const schemaDid = await ensureSchema(bank, 'AccreditedInvestor', openSchema('AccreditedInvestor'));
  const oneYear = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
  const credDid = await issueClaim(
    bank,
    sovId.did,
    schemaDid,
    { type: 'AccreditedInvestor', authority: 'Meridian Capital', tier: 'accredited' },
    oneYear,
  );
  assert(await acceptCredential(sovereign, credDid), 'the Sovereign accepts the bank VC');
  const leaf = await recordIssuedCredential(sovereign, credDid, sovereign.dataFolder);
  assert(leaf.trustClass === 'issued' && leaf.issuer === bankId.did, 'the accepted VC is an `issued` leaf from the bank');

  process.stdout.write("\n▸ Warden write-hosts the VC into the Sovereign's private member-key partition\n");
  const res = await ingestCredentialToPartition(warden, config, { spaceId: SPACE, ownerDid: sovId.did, leaf });
  const store = new VaultStore(warden.dataFolder);
  const art = await store.get(res.artefactId);
  assert(!!art && art.sealedTo?.partition === res.partitionId, "the VC artefact is sealed to the Sovereign's partition");
  assert(art?.scope === 'private' && art?.owner === sovId.did, "it is scoped private, owned by the Sovereign");

  process.stdout.write('\n▸ At rest, the Warden CANNOT read it (write-host / read-guest)\n');
  let wardenRead: string | null = null;
  try {
    wardenRead = await unsealAsWarden(warden, art!.ciphertext);
  } catch {
    wardenRead = null;
  }
  assert(wardenRead === null, 'unsealAsWarden FAILS — the Warden write-hosts but cannot read the VC at rest');

  process.stdout.write("\n▸ The Sovereign's partition key opens it (the read-guest recall path)\n");
  const partition = await new PartitionStore(warden.dataFolder).get(SPACE, sovId.did);
  const priv = await unwrapKey(sovereign, partition!.wrappedKey!); // the Sovereign unwraps its own partition key
  const text = (JSON.parse(openWithKey(warden.cipher, priv, art!.ciphertext)) as { text: string }).text;
  assert(/AccreditedInvestor/.test(text) && /accredited/.test(text), `the partition read recovers the VC fact: “${text}”`);

  process.stdout.write('\n▸ It stays linked to the signed credential — trust remains with the ISSUER\n');
  assert(
    art!.metadata.credentialDid === credDid &&
      art!.metadata.issuer === bankId.did &&
      art!.metadata.trustClass === 'issued',
    'the artefact links back to the signed credential (credentialDid + issuer + trustClass:issued)',
  );

  process.stdout.write(
    '\n✓ VC → KB bridge: a 3rd-party VC is private-from-the-Warden knowledge, recallable by the Sovereign,\n' +
      '  still provable via the issuer — the two threads (subject-keyed intake + member-key partition) as one flow.\n',
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-finance-vault: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
