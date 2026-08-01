/**
 * e2e: AGENT-AS-SOVEREIGN MCP — the identity-binding proof + the read that used to need a hand-rolled script.
 *
 * This package AUGMENTS Archon's @didcid/mcp-server (it does NOT rewrite it): the binding is REUSED via that
 * package's `createArchonRuntime`, and we add only `hearthold_*` custodian verbs. This proves:
 *   - the binding: `createArchonRuntime` opens a bound agent identity; `hearthold_whoami` reports it (DID +
 *     registry) — "which Sovereign am I, in which registry", answered as configuration, not per-call plumbing;
 *   - `hearthold_read_card`: resolve + decrypt a card AS ME, auto-picking the format (a sealed message,
 *     JSON, or a credential) — the exact read that took a six-env-var docker script;
 *   - the facade verbs call the agent's own control plane correctly (mock), and error clearly without a URL;
 *   - every tool is `hearthold_*` (we never redefine an `archon_*` tool) and the MCP server assembles them.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-agent-mcp.ts
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createArchonRuntime, type ArchonRuntime, type McpServerConfig } from '@didcid/mcp-server';
import { HEARTHOLD_TOOLS, type HeartholdToolContext } from '@hearthold/agent-mcp/tools';
import { buildServer } from '@hearthold/agent-mcp/server';
import { loadConfig } from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);
const tool = (name: string) => {
  const t = HEARTHOLD_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no such tool ${name}`);
  return t;
};

async function main(): Promise<void> {
  const base = loadConfig();
  const dir = mkdtempSync(join(tmpdir(), 'hearthold-agent-mcp-'));
  const archon: McpServerConfig = {
    nodeUrl: base.nodeUrl,
    walletType: 'json',
    walletPath: join(dir, 'wallet.json'),
    passphrase: 'hearthold-agent-mcp-e2e',
    defaultRegistry: base.registry,
    readOnly: false,
    inlineLimit: 16 * 1024,
  };

  try {
    step('BINDING — createArchonRuntime (David’s) opens a bound agent identity; we provision one to bind to');
    const runtime: ArchonRuntime = await createArchonRuntime(archon);
    if (!runtime.keymaster) throw new Error('runtime has no keymaster');
    const km = runtime.keymaster;
    // Provision (Aegis would do this): an agent id + a separate sender id, both born local.
    await km.createId('agent', { registry: base.registry } as never);
    await km.createId('sender', { registry: base.registry } as never);
    await km.setCurrentId('agent');
    const agentDid = await km.resolveDID('agent').then((d: any) => d?.didDocument?.id ?? '');
    check('the bound agent identity is born on the LOCAL registry', typeof agentDid === 'string' && agentDid.startsWith('did:'));

    const ctx: HeartholdToolContext = { runtime, control: {}, identity: { did: agentDid, name: 'agent' } };

    step('hearthold_whoami — the binding is legible ("which Sovereign am I, in which registry")');
    const who = (await tool('hearthold_whoami').handler(ctx, {})) as { did: string; name: string; identityRegistry?: string };
    check('whoami returns my bound DID + name', who.did === agentDid && who.name === 'agent');
    check('whoami reports my identity registry (local)', who.identityRegistry === base.registry);

    step('hearthold_read_card — resolve + decrypt AS ME, auto-picking the format (the read that hurt)');
    // A sender seals a JSON card and a plain message to the agent's DID (encryptMessage format — the exact
    // case that broke when someone reached for decryptJSON).
    await km.setCurrentId('sender');
    const jsonCard = await km.encryptMessage(JSON.stringify({ secret: 'passed to you', n: 42 }), agentDid);
    const msgCard = await km.encryptMessage('a plain passed note', agentDid);
    await km.setCurrentId('agent');
    const readJson = (await tool('hearthold_read_card').handler(ctx, { did: jsonCard })) as { kind: string; data?: any };
    check('a sealed JSON card auto-decodes to {kind:json, data}', readJson.kind === 'json' && readJson.data?.secret === 'passed to you' && readJson.data?.n === 42);
    const readMsg = (await tool('hearthold_read_card').handler(ctx, { did: msgCard })) as { kind: string; text?: string };
    check('a sealed plain message auto-decodes to {kind:message, text}', readMsg.kind === 'message' && readMsg.text === 'a plain passed note');
    let readErr = '';
    try { await tool('hearthold_read_card').handler(ctx, { did: 'did:cid:notmine' }); } catch (e) { readErr = e instanceof Error ? e.message : String(e); }
    check('an unreadable/foreign DID fails with a clear "as me" error', /could not read/.test(readErr));

    step('FACADE verbs — call the agent’s own control plane correctly (mock), and error clearly without a URL');
    const hits: { method?: string; url?: string; body?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/card/inbound') res.end(JSON.stringify({ inbound: [{ did: 'did:cid:card1' }] }));
        else if (req.url === '/api/recall') res.end(JSON.stringify({ citations: [{ id: 'a', text: 'recalled' }] }));
        else res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const withWarden: HeartholdToolContext = { ...ctx, control: { wardenUrl: `http://127.0.0.1:${port}` } };

    const inbound = (await tool('hearthold_list_inbound').handler(withWarden, {})) as { inbound: unknown[] };
    check('list_inbound GETs the Warden inbound route', hits.some((h) => h.method === 'GET' && h.url === '/api/card/inbound') && inbound.inbound.length === 1);
    const recall = (await tool('hearthold_recall').handler(withWarden, { query: 'when did I visit Paris' })) as { citations: unknown[] };
    const recallHit = hits.find((h) => h.url === '/api/recall');
    check('recall POSTs the query to the Warden recall route', recallHit?.method === 'POST' && JSON.parse(recallHit?.body ?? '{}').query === 'when did I visit Paris' && recall.citations.length === 1);
    // FIELD-NAME MAPPING — the facade must POST the EXACT control-types request fields (Sevenfold caught
    // accept_card sending {did} when the route wants {credentialDid}). Assert every write facade's body.
    const bodyOf = (url: string) => JSON.parse([...hits].reverse().find((h) => h.url === url)?.body ?? '{}');
    await tool('hearthold_accept_card').handler(withWarden, { credentialDid: 'did:cid:c1' });
    check('accept_card POSTs { credentialDid } (not { did })', bodyOf('/api/card/accept').credentialDid === 'did:cid:c1');
    await tool('hearthold_decline_card').handler(withWarden, { credentialDid: 'did:cid:c2' });
    check('decline_card POSTs { credentialDid }', bodyOf('/api/card/decline').credentialDid === 'did:cid:c2');
    await tool('hearthold_confirm_triage').handler(withWarden, { artefactId: 'a1', sensitivity: 2 });
    const ct = bodyOf('/api/triage/confirm');
    check('confirm_triage POSTs { artefactId, sensitivity:number } (not { id })', ct.artefactId === 'a1' && ct.sensitivity === 2);
    await tool('hearthold_pass_card').handler(withWarden, { toDid: 'did:cid:seven', cardDid: 'did:cid:card' });
    check('pass_card maps cardDid → { credentialDid }', bodyOf('/api/card/pass').credentialDid === 'did:cid:card');

    let noUrlErr = '';
    try { await tool('hearthold_list_inbound').handler(ctx, {}); } catch (e) { noUrlErr = e instanceof Error ? e.message : String(e); }
    check('a facade tool without its control URL errors clearly (read tools still work)', /needs the Warden control URL/.test(noUrlErr));
    server.close();

    step('AUGMENT, not rewrite — every tool is hearthold_* and the MCP server assembles them');
    check('all tools are namespaced hearthold_* (no archon_* redefined)', HEARTHOLD_TOOLS.every((t) => t.name.startsWith('hearthold_')));
    check('each tool has a description + JSON-Schema inputSchema', HEARTHOLD_TOOLS.every((t) => t.description.length > 0 && typeof t.inputSchema === 'object'));
    check('the read-ish core is present (whoami/read_card/list_inbound/recall)', ['hearthold_whoami', 'hearthold_read_card', 'hearthold_list_inbound', 'hearthold_recall'].every((n) => HEARTHOLD_TOOLS.some((t) => t.name === n)));
    const srv = buildServer(ctx);
    check('buildServer assembles the MCP server without throwing', !!srv && typeof srv.connect === 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ agent-mcp: binding reused from @didcid/mcp-server; whoami + read_card (auto-pick) prove the bind; facades call the control plane; hearthold_* augments archon_*\n'
      : `\n✗ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-agent-mcp: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
