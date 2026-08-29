/**
 * e2e: provenSovereignDid — the #40 proven Sovereign source, verified against a REAL parent-signed allowance.
 *
 * Proves `verifyProvenSovereign` (core) against a live node:
 *   1. PROVEN — a parent-signed control-allowance whose actor is the agent's own Sovereign → verify returns
 *      that ACTOR (the agent's DID), NOT the signer (the parent). Parent-attested, chain-verified.
 *   2. FORGED — the same allowance body SELF-signed by the agent (not the parent) → undefined (governor-
 *      pinning to the parent rejects it). A self-widened attestation proves nothing.
 *   3. UNVERIFIABLE — no parent, or no allowance asset → undefined (never a config fallback).
 *
 * Run:  npm run e2e:proven-sovereign
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signRuleset,
  verifyProvenSovereign,
  type KeymasterHandle,
  type Ruleset,
} from '@hearthold/core';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(here, '..', '.hearthold-e2e-proven-sovereign');
const PASSPHRASE = process.env.HEARTHOLD_PASSPHRASE ?? 'hearthold-e2e-passphrase';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const allowance = (agentSovDid: string): Ruleset =>
  ({
    actor: agentSovDid,
    actorKind: 'sovereign',
    version: 1,
    previous: null,
    capabilities: { control: { selfApprove: [] } },
    ceiling: 0,
    status: 'active',
  }) as Ruleset;

async function main(): Promise<void> {
  const config = { ...loadConfig(), dataRoot: DATA_ROOT };
  process.stdout.write(`Hearthold provenSovereign e2e\n  node: ${config.nodeUrl}\n  data: ${DATA_ROOT}\n`);

  step('Provision parent (node sovereign), the agent Sovereign (the actor), and a verifying Warden');
  const parent: KeymasterHandle = await openKeymaster('sovereign', config, PASSPHRASE); // the node sovereign — signs
  const agentSov: KeymasterHandle = await openKeymaster('emissary', config, PASSPHRASE); // the agent's OWN Sovereign
  const warden: KeymasterHandle = await openKeymaster('warden', config, PASSPHRASE); // any custodian handle verifies
  const parentId = await ensureIdentity(parent, config);
  const agentId = await ensureIdentity(agentSov, config);
  await ensureIdentity(warden, config);
  check('identities ready', parentId.did.startsWith('did:') && agentId.did.startsWith('did:'));

  step('PROVEN: parent signs an allowance whose actor is the agent Sovereign');
  const parentSigned = await signRuleset(parent, allowance(agentId.did));
  const allowanceAsset = await parent.keymaster.createAsset([parentSigned], { registry: config.registry });
  const proven = await verifyProvenSovereign(warden, { parentDid: parentId.did, controlAllowanceAsset: allowanceAsset });
  check('verify returns the AGENT Sovereign (the actor), parent-attested', proven === agentId.did);
  check('verify returns the ACTOR, NOT the signer (parent)', proven !== parentId.did);

  step('FORGED: the agent self-signs the same allowance — governor-pinning to the parent must reject it');
  const selfSigned = await signRuleset(agentSov, allowance(agentId.did));
  const forgedAsset = await agentSov.keymaster.createAsset([selfSigned], { registry: config.registry });
  const forged = await verifyProvenSovereign(warden, { parentDid: parentId.did, controlAllowanceAsset: forgedAsset });
  check('a self-signed allowance proves NOTHING (undefined — wrong signer)', forged === undefined);

  step('UNVERIFIABLE: no parent, or no allowance asset → undefined (never a config fallback)');
  const noParent = await verifyProvenSovereign(warden, { controlAllowanceAsset: allowanceAsset });
  check('no parentDid → undefined (root agent / unconfigured)', noParent === undefined);
  const noAsset = await verifyProvenSovereign(warden, { parentDid: parentId.did });
  check('no allowance asset → undefined', noAsset === undefined);
  const badAsset = await verifyProvenSovereign(warden, { parentDid: parentId.did, controlAllowanceAsset: 'did:cid:bogus' });
  check('an unresolvable asset → undefined', badAsset === undefined);

  process.stdout.write(failures === 0 ? '\nPASS\n' : `\nFAIL (${failures})\n`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
