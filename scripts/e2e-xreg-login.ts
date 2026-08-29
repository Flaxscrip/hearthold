/**
 * Go/no-go for T3: can a `local`-registry group hold + authenticate a member whose identity lives on a
 * DIFFERENT (non-local) registry? This is the load-bearing, previously-unproven assumption behind serving
 * the agency KB from a node that has BOTH `local` and `BTC:mainnet` (flaxlap): the access-control objects are
 * born `local` (no gossip, no stall) while David's member DID lives on `BTC:mainnet`.
 *
 * We can't mint on BTC:mainnet (real BTC), so we use `hyperswarm` as a RESOLVABLE non-local proxy. It proves
 * the mechanic — local group + cross-registry member + kb-web-style login — but not BTC:mainnet's chain
 * semantics specifically. Run on a node that resolves both (flaxlap):
 *   HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_PASSPHRASE=… node --experimental-strip-types scripts/e2e-xreg-login.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  createRegistryGroup,
  grantAuthorization,
} from '@hearthold/core';

const ok = (cond: boolean, msg: string): void => {
  process.stdout.write(`  ${cond ? '✓' : '✗ FAIL:'} ${msg}\n`);
  if (!cond) process.exitCode = 1;
};

async function resolvable(handle: Awaited<ReturnType<typeof openKeymaster>>, did: string, label: string, timeoutMs = 90_000): Promise<boolean> {
  const start = Date.now();
  for (let i = 0; Date.now() - start < timeoutMs; i++) {
    try {
      await handle.gatekeeper.processEvents(); // drain the queuing (hyperswarm) writes so peers can resolve
    } catch { /* processEvents may be a no-op / transient */ }
    const doc = await handle.keymaster.resolveDID(did).catch(() => undefined);
    const id = typeof doc === 'string' ? doc : (doc as { didDocument?: { id?: string } } | undefined)?.didDocument?.id;
    if (id === did) {
      process.stdout.write(`    ${label} resolvable after ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  process.stdout.write(`    ${label} did NOT become resolvable within ${timeoutMs / 1000}s\n`);
  return false;
}

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = process.env.HEARTHOLD_PASSPHRASE ?? 'xreg-test';
  // Warden + its groups on LOCAL. Member on HYPERSWARM (the non-local, resolvable proxy for BTC:mainnet).
  const localCfg = { ...base, registry: 'local', contentRegistry: 'local', ephemeralRegistry: 'local' };
  const swarmCfg = { ...base, registry: 'hyperswarm', contentRegistry: 'local', ephemeralRegistry: 'hyperswarm' };

  const warden = await openKeymaster('warden', localCfg, pass);
  const member = await openKeymaster('verifier', swarmCfg, pass); // authorized member, on hyperswarm
  const stranger = await openKeymaster('sovereign', swarmCfg, pass); // authenticates, NOT a member
  const wid = await ensureIdentity(warden, localCfg);
  const mid = await ensureIdentity(member, swarmCfg);
  const sid = await ensureIdentity(stranger, swarmCfg);
  process.stdout.write(`Warden(local) ${wid.did.slice(0, 24)}…  member(hyperswarm) ${mid.did.slice(0, 24)}…\n`);

  process.stdout.write('\n▸ 0. The hyperswarm member must become resolvable on the Warden\'s node\n');
  const memberResolvable = await resolvable(warden, mid.did, 'member');
  ok(memberResolvable, 'the Warden (local) resolves a member whose identity is on hyperswarm');
  if (!memberResolvable) {
    process.stdout.write('\n  Cannot proceed — the cross-registry member never anchored. (This itself is the finding:\n  a non-local member may not confirm reliably; on BTC:mainnet, David\'s DID is already anchored, so this\n  step models the anchoring only, not David.)\n');
    return;
  }

  process.stdout.write('\n▸ 1. GRANT — addGroupMember(localGroup, hyperswarmMemberDid)\n');
  const readGroup = await createRegistryGroup(warden, `xreg-read-${Date.now() % 100000}`, 'local');
  let granted = false;
  try {
    await grantAuthorization(warden, readGroup, mid.did);
    granted = true;
  } catch (e) {
    process.stdout.write(`    grant threw: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  ok(granted, 'a LOCAL group accepts a member DID on a non-local registry (enrollment resolves cross-registry)');

  process.stdout.write('\n▸ 2. AUTHORIZE — testGroup(localGroup, member) true; testGroup(localGroup, stranger) false\n');
  const memberIn = await warden.keymaster.testGroup(readGroup, mid.did).catch(() => false);
  const strangerIn = await warden.keymaster.testGroup(readGroup, sid.did).catch(() => false);
  ok(memberIn === true, 'the local group authorizes the hyperswarm member');
  ok(strangerIn === false, 'the local group does NOT authorize a non-member');

  process.stdout.write('\n▸ 3. LOGIN — cross-sphere challenge/response (LOCAL challenge, HYPERSWARM member response)\n');
  const createChallenge = warden.keymaster.createChallenge.bind(warden.keymaster) as (c?: Record<string, unknown>, o?: Record<string, unknown>) => Promise<string>;
  const verifyResponse = warden.keymaster.verifyResponse.bind(warden.keymaster) as (r: string, o?: Record<string, unknown>) => Promise<{ match?: boolean; responder?: string }>;
  const challenge = await createChallenge({ callback: 'https://agentic.example/cb' }, { registry: 'local' });
  process.stdout.write('    Warden issued a LOCAL challenge; member responds on hyperswarm…\n');
  const responseDID = await member.keymaster.createResponse(challenge, { registry: 'hyperswarm' });
  // The member's response DID is minted on hyperswarm (queues) — drain + confirm resolvable before verify.
  const respResolvable = await resolvable(member, responseDID, 'response');
  ok(respResolvable, 'the hyperswarm member\'s response DID anchors + resolves');
  let verified: { match?: boolean; responder?: string } = { match: false };
  if (respResolvable) verified = await verifyResponse(responseDID).catch((e) => ({ match: false, responder: `ERR ${e instanceof Error ? e.message : e}` }));
  ok(verified.match === true, 'the Warden verifies a cross-sphere response (local challenge ⇄ hyperswarm member)');
  ok(verified.responder === mid.did, 'the verified responder is the member DID');

  process.stdout.write('\n');
  if (process.exitCode === 1) {
    process.stdout.write('✗ T3 mechanic NOT fully proven — see the failing line(s) above.\n');
  } else {
    process.stdout.write('✓ T3 mechanic PROVEN (via a hyperswarm proxy): a local group grants + authorizes + logs in a\n');
    process.stdout.write('  member on a non-local registry. BTC:mainnet is a chain registry — a signet/real-David confirm may\n');
    process.stdout.write('  still be wanted, but the local-group ⇄ cross-registry-member ⇄ kb-web-login path holds.\n');
  }
}

main().catch((err) => {
  process.stderr.write(`e2e-xreg-login: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
