/**
 * A tiny localhost control server for the agent daemons.
 *
 * Each GUI (Warden Console, Signet Approver, Witness) is a browser app that drives its agent over
 * this JSON HTTP API plus a Server-Sent-Events stream at `GET /api/events`. The agent keeps its real
 * Keymaster + DIDComm loop; this only exposes control + a live event feed.
 *
 * Dependency-free (node built-in `http`), mirroring the registry's TRQP server. Binds to loopback
 * by default and sends permissive CORS — it is a **local dev / single-machine** control plane, not
 * an authenticated public API. Do not expose it beyond localhost/your tailnet.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface ControlContext {
  /** Parsed JSON body for POST/PUT (undefined otherwise). */
  body: unknown;
  /** URL query parameters. */
  query: URLSearchParams;
  req: IncomingMessage;
}

/** A route handler returns a JSON-serialisable value (sent as `{ ok: true, ...value }`). */
export type ControlHandler = (ctx: ControlContext) => Promise<unknown> | unknown;

export interface ControlServer {
  /** Push an event to every connected SSE client. */
  emit(type: string, data: unknown): void;
  /** Number of connected SSE clients. */
  clientCount(): number;
  close(): void;
  readonly port: number;
}

export interface ControlServerOptions {
  port: number;
  host?: string;
  /** Map of `"GET /api/status"` → handler. Path `/api/events` is reserved for the SSE stream. */
  routes: Record<string, ControlHandler>;
  /** Called once the server is listening. */
  onListening?: (port: number) => void;
}

const sse = new Set<ServerResponse>();

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Start the control server. Returns a handle with `emit` for pushing SSE events. */
export function startControlServer(options: ControlServerOptions): ControlServer {
  const host = options.host ?? '127.0.0.1';

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname;

    // SSE stream — clients subscribe here for live events.
    if (method === 'GET' && path === '/api/events') {
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }

    const key = `${method} ${path}`;
    const route = options.routes[key];
    if (!route) {
      sendJson(res, 404, { ok: false, error: `no route ${key}` });
      return;
    }

    try {
      const body = method === 'GET' ? undefined : await readBody(req);
      const result = await route({ body, query: url.searchParams, req });
      sendJson(res, 200, { ok: true, ...(result as object) });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  server.listen(options.port, host, () => options.onListening?.(options.port));

  return {
    port: options.port,
    emit(type: string, data: unknown): void {
      const frame = `data: ${JSON.stringify({ type, at: new Date().toISOString(), data })}\n\n`;
      for (const client of sse) client.write(frame);
    },
    clientCount: () => sse.size,
    close(): void {
      for (const client of sse) client.end();
      sse.clear();
      server.close();
    },
  };
}
