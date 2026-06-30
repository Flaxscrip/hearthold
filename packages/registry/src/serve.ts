/**
 * A minimal TRQP v2.0 HTTP endpoint over a `TrustEvaluator`, wire-compatible with
 * `archon-trust-registry` (the registry `hatpro-archon` runs on :4260). Uses Node's built-in `http`
 * server — no framework dependency. Any TRQP client (including Hearthold's `HttpTrustRegistry`) can
 * query it.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

import type { TrustEvaluator, TrqpAction } from '@hearthold/core';

export interface TrqpServerOptions {
  port: number;
  /** This registry's authority DID (`authority_id`). */
  authorityId: string;
  /** Human-readable registry name, surfaced in `/metadata`. */
  registryName: string;
}

const SUPPORTED_ACTIONS: TrqpAction[] = ['issue', 'verify', 'hold', 'present', 'revoke'];

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** Start the TRQP server. Returns the http.Server (call `.close()` to stop). */
export function startTrqpServer(evaluator: TrustEvaluator, opts: TrqpServerOptions): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/health') {
        return send(res, 200, { status: 'ok', trqp_version: '2.0', registry_id: opts.authorityId });
      }
      if (path === '/metadata') {
        return send(res, 200, {
          registry_id: opts.authorityId,
          registry_name: opts.registryName,
          trqp_version: '2.0',
          supported_query_types: ['authorization'],
          supported_actions: SUPPORTED_ACTIONS,
        });
      }
      if (path === '/authorization') {
        // Accept POST (JSON body) or GET (query string), like archon-trust-registry.
        const q =
          req.method === 'GET'
            ? Object.fromEntries(url.searchParams)
            : ((await readBody(req)) as Record<string, unknown>);
        const entity_id = String(q.entity_id ?? '');
        const action = String(q.action ?? '');
        const resource = q.resource != null ? String(q.resource) : undefined;
        if (!entity_id || !action) {
          return send(res, 400, { authorized: false, message: 'entity_id and action are required' });
        }
        const now = new Date().toISOString();
        const result = await evaluator.authorize({
          entity_id,
          action,
          resource,
          authority_id: q.authority_id != null ? String(q.authority_id) : opts.authorityId,
        });
        return send(res, 200, { ...result, time_requested: now, time_evaluated: new Date().toISOString() });
      }
      send(res, 404, { error: `not found: ${path}` });
    })().catch((e: unknown) => send(res, 500, { error: e instanceof Error ? e.message : String(e) }));
  });
  server.listen(opts.port);
  return server;
}
