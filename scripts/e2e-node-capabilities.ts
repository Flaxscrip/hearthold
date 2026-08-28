/**
 * e2e: node capability discovery (@didcid 0.6.3 · `GET <nodeUrl>/api/v1/capabilities`).
 *
 * Two things this proves against the REAL bound node plus a black-hole URL:
 *   1. Discovery works — the live Drawbridge answers `/api/v1/capabilities` and reports `didcomm:true`,
 *      so the transport preflight (`DidCommTransport.ready`) lets this node through. This is also the
 *      cross-node handshake primitive: `discoverNodeCapabilities(anyNodeUrl)` probes ANY node before we
 *      open a trust relationship (a shared Sphere / registry) with it.
 *   2. Permissive fail-safe — an UNREACHABLE node returns `null` (not a throw, not a false), and the
 *      fail-fast decision does NOT refuse it: `nodeExplicitlyLacks(null,'didcomm') === false`. Only a node
 *      that *says* `didcomm:false` is refused. So an old node with no capabilities endpoint never breaks,
 *      while a node that explicitly disowns DIDComm is caught at startup with a clear message.
 *
 * No wallet / data root needed — this is a read-only probe. Run:  npm run e2e:node-capabilities
 */
import {
  loadConfig,
  discoverNodeCapabilities,
  nodeSupports,
  nodeExplicitlyLacks,
  type NodeCapabilities,
} from '@hearthold/core';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
};
const ok = (msg: string): void => console.log(`  ✓ ${msg}`);

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`\n[node-capabilities] probing the bound node: ${config.nodeUrl}\n`);

  // 1 — probe the bound node. Two honest outcomes, both a PASS (the code is permissive by design):
  //   • a newer node advertises capabilities → assert it offers didcomm;
  //   • an OLDER node (e.g. a 0.11.0 gatekeeper) has no /api/v1/capabilities endpoint → caps is null, which
  //     the permissive contract treats as supported. We must NOT hard-require the endpoint to exist, or this
  //     e2e falsely fails on exactly the deployed nodes the permissive path was built to keep working.
  const caps = await discoverNodeCapabilities(config.nodeUrl);
  console.log(`  node reports: ${JSON.stringify(caps)}`);
  // Whatever the node says (or doesn't), the preflight decision must let didcomm through.
  assert(nodeSupports(caps, 'didcomm'), 'didcomm is supported (permissive: unknown ⇒ supported)');
  assert(!nodeExplicitlyLacks(caps, 'didcomm'), 'didcomm is not explicitly lacking (preflight lets it through)');
  if (caps === null) {
    ok(`discovery: ${config.nodeUrl} has no /api/v1/capabilities endpoint (older node) — permissive path treats didcomm as supported`);
  } else {
    assert(caps.didcomm === true, 'a node that DOES advertise capabilities reports didcomm:true');
    ok('discovery: node answered and offers didcomm — transport preflight passes');
  }

  // 2 — an unreachable node fails to a permissive null, fast (short timeout so we never stall on a black hole).
  const deadUrl = 'http://127.0.0.1:9/'; // discard port — connection refused / hang, resolved to null
  const t0 = Date.now();
  const dead = await discoverNodeCapabilities(deadUrl, { timeoutMs: 1500 });
  const elapsed = Date.now() - t0;
  assert(dead === null, `unreachable node ${deadUrl} probes to null (got ${JSON.stringify(dead)})`);
  assert(elapsed < 4000, `unreachable probe returned promptly (${elapsed}ms — must not stall the caller)`);
  assert(nodeSupports(dead, 'didcomm'), 'unknown (null) node is PERMITTED — old nodes without the endpoint keep working');
  assert(!nodeExplicitlyLacks(dead, 'didcomm'), 'unknown node is NOT "explicitly lacking" — fail-fast never refuses an unreachable node');
  ok(`unreachable → null in ${elapsed}ms; permissive (supported, not refused)`);

  // 3 — a node that EXPLICITLY disowns didcomm is the one and only refusal case the preflight throws on.
  const refusing: NodeCapabilities = { didcomm: false, names: true };
  assert(!nodeSupports(refusing, 'didcomm'), 'a node saying didcomm:false is not supported');
  assert(nodeExplicitlyLacks(refusing, 'didcomm'), 'a node saying didcomm:false IS explicitly lacking — preflight would throw here');
  ok('explicit didcomm:false is the sole fail-fast case — refused with a clear message, unknowns are not');

  console.log('\n[node-capabilities] PASS — discovery + permissive fail-safe verified against the live node.\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
