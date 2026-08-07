/**
 * e2e: the agent-MCP driven through the REAL MCP protocol (caveat: the smoke tested profile logic, not
 * dispatch). An in-memory client↔server pair: list tools for a role, call a keymaster-direct verb end to end,
 * and confirm a façade verb routes to the right control-plane URL and returns through the wire.
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-agent-mcp-dispatch.ts
 */
import { loadConfig, openKeymaster, ensureIdentity } from '@hearthold/core';
import { buildServer } from '@hearthold/agent-mcp/server';
import { toolsForRole, type HeartholdToolContext } from '@hearthold/agent-mcp/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function connect(ctx: HeartholdToolContext, tools: ReturnType<typeof toolsForRole>): Promise<Client> {
  const server = buildServer(ctx, tools);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dispatch-test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}
const textOf = (res: unknown): string => ((res as { content?: { text?: string }[] }).content?.[0]?.text) ?? '';

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'agent-mcp-dispatch';
  const handle = await openKeymaster('verifier', config, pass);
  const id = await ensureIdentity(handle, config);
  const runtime = { keymaster: handle.keymaster } as HeartholdToolContext['runtime'];

  line('\n════ MCP protocol dispatch ════');

  // 1. list tools for a role, over the wire.
  const vClient = await connect({ runtime, control: {}, identity: { did: id.did, name: id.name } }, toolsForRole('verifier'));
  const listed = (await vClient.listTools()).tools.map((t) => t.name);
  check('listTools (verifier) → the verifier profile, not the emissary', listed.includes('hearthold_whoami') && listed.includes('hearthold_verify_card') && !listed.includes('hearthold_invoke'), listed.join(', '));

  // 2. call a keymaster-direct verb end to end — the result crosses the protocol.
  const who = await vClient.callTool({ name: 'hearthold_whoami', arguments: {} });
  const whoParsed = JSON.parse(textOf(who) || '{}') as { did?: string };
  check('callTool hearthold_whoami → my DID, through the protocol', whoParsed.did === id.did, whoParsed.did ?? 'none');

  // 3. a façade verb routes to the right control URL + returns the daemon's reply through the wire.
  const eClient = await connect({ runtime, control: { emissaryUrl: 'http://stub.local:9' }, identity: { did: id.did, name: id.name } }, toolsForRole('emissary'));
  let calledUrl = '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ ok: true, status: 'granted', credentialDid: 'did:cid:evidence', schemaDid: 'did:cid:schema' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const inv = await eClient.callTool({ name: 'hearthold_invoke', arguments: { claim: 'resided in FR', kind: 'location' } });
    const invParsed = JSON.parse(textOf(inv) || '{}') as { status?: string };
    check('hearthold_invoke routes to the Emissary /api/invoke', calledUrl === 'http://stub.local:9/api/invoke', calledUrl);
    check('the daemon reply crosses back through the protocol', invParsed.status === 'granted', JSON.stringify(invParsed));
  } finally {
    globalThis.fetch = realFetch;
  }

  line(`\n${failures === 0 ? '✅ ALL PASS — the MCP protocol dispatch works end to end' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
