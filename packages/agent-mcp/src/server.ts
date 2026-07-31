/**
 * The MCP server wiring — the SDK's LOW-LEVEL `Server` with plain JSON-Schema tool definitions (no zod
 * authored here, so no zod-version coupling to the SDK or to `@didcid/mcp-server`). It serves only the
 * Hearthold custodian verbs; Archon's `archon_*` tools stay in the sibling `@didcid/mcp-server`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { HEARTHOLD_TOOLS, type HeartholdToolContext } from './tools.js';

export function buildServer(ctx: HeartholdToolContext): Server {
  const server = new Server(
    { name: 'hearthold-agent-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: HEARTHOLD_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = HEARTHOLD_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }] };
    try {
      const result = await tool.handler(ctx, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  });

  return server;
}
