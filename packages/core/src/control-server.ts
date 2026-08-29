/**
 * A tiny localhost control server for the agent daemons.
 *
 * Each GUI (Warden Console, Signet Approver, Emissary) is a browser app that drives its agent over
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

/** A route error carrying an HTTP status (read by the server's catch; plain Errors default to 400). */
export class ControlHttpError extends Error {
  // Plain field + assignment rather than a constructor parameter property, so this module is importable under
  // `node --experimental-strip-types` (strip-only mode rejects parameter properties) — which lets the origin
  // policy below be unit-tested directly.
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ControlHttpError';
  }
}

/** No proven session where one is required — the server sends 401. */
export class UnauthorizedError extends ControlHttpError {
  constructor(message = 'log in — this node requires a session') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

/** A named resource does not exist — the server sends 404. */
export class NotFoundError extends ControlHttpError {
  constructor(message = 'not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

/** A route handler returns a JSON-serialisable value (sent as `{ ok: true, ...value }`). */
export type ControlHandler = (ctx: ControlContext) => Promise<unknown> | unknown;

/** Who an SSE frame is for. Absent = broadcast; otherwise a member (owner) and/or the shared pool. */
export interface EventAudience {
  owner?: string;
  scope?: 'shared' | 'private';
}

export interface ControlServer {
  /** Push an event to connected SSE clients — all, or only the `audience` (session-filtered, Phase 3). */
  emit(type: string, data: unknown, audience?: EventAudience): void;
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
  /** Resolve an SSE connection's viewer DID from its `X-Hearthold-Session` token (for audience filtering). */
  resolveSession?: (token: string | undefined) => string | undefined;
  /**
   * Extra browser origins allowed to call this control plane, beyond loopback. The default already allows any
   * `http(s)://localhost|127.0.0.1|[::1]:<port>` (a local Table on any port); add full origin strings here for
   * a deployed Table (e.g. `https://table.example`). NEVER `*` — the control API is unauthenticated at the
   * transport and loopback-bound, so a wildcard is a DNS-rebinding / localhost-CSRF surface.
   */
  allowOrigins?: string[];
  /**
   * Mark this as a PUBLIC-facing portal (the kb-web login/session Mage) reached by bring-your-own-wallet
   * clients whose Origin can't be enumerated — a browser extension (per-install `chrome-extension://` /
   * `moz-extension://` ids), a mobile or desktop wallet, etc. The Origin allowlist is NOT the security boundary
   * for such a service: any non-browser caller already bypasses it (a missing Origin header passes), and it
   * cannot list per-install extension origins — so enforcing the full allowlist only blocks legitimate clients.
   * When true, browser-EXTENSION origins (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`
   * — the wallet add-on on any engine) are additionally accepted and reflected; arbitrary named web origins are
   * NOT (a drive-by http(s) page still
   * falls to the allowlist and is refused, so the open web gains no CORS read access), and the opaque `null`
   * stays refused. The real gates are the SIGNED challenge/response (verified server-side) and the per-login
   * poll secret — never the Origin. The Host anti-rebinding check is unchanged. Default false — every local
   * control plane keeps its strict Origin allowlist.
   */
  publicPortal?: boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const bareHost = (h: string | undefined): string => (h ?? '').split(':')[0]?.toLowerCase().replace(/^\[|\]$/g, '') ?? '';

/** Anti-DNS-rebinding: only answer to loopback, the bound host, or an allowed origin's host. A missing/rebound Host is refused. */
function isAllowedHost(hostHeader: string | undefined, bindHost: string, allowOrigins: string[]): boolean {
  const name = bareHost(hostHeader);
  if (!name) return false;
  if (LOOPBACK.has(name)) return true;
  const bind = bindHost.toLowerCase();
  if (bind !== '0.0.0.0' && bind !== '::' && name === bind) return true;
  return allowOrigins.some((o) => {
    try {
      return bareHost(new URL(o).host) === name;
    } catch {
      return false;
    }
  });
}

/** A browser `Origin` is allowed iff it is loopback (any port), explicitly configured, or — on a public portal
 *  — a browser-EXTENSION origin. Absent Origin = non-browser/same-origin → allowed; `null` (opaque) is refused
 *  in BOTH modes (see `publicPortal`). A public portal does NOT admit arbitrary named web origins: a drive-by
 *  http(s) page still falls to the allowlist and is refused, so the open web gains no CORS read access. */
export function isAllowedOrigin(origin: string | undefined, allowOrigins: string[], publicPortal = false): boolean {
  if (origin === undefined) return true; // curl / same-origin — no Origin header
  if (origin === 'null') return false; // opaque origin (sandboxed iframe, file://) — refused in both modes
  // A public BYO-wallet portal additionally admits browser-EXTENSION origins — the wallet add-on, whose
  // per-install id can't be enumerated in an allowlist. All three engines' schemes are covered
  // (chrome-extension://<id>, moz-extension://<uuid>, safari-web-extension://<uuid> — the Mac/Safari path a
  // Xcode-converted build takes; flaxscrip and David are on Macs). It does NOT open the check to arbitrary
  // named origins: an http(s) page falls through to the allowlist below. A hostile extension already holds
  // host permissions and bypasses CORS from its service worker, so refusing extension origins never stopped a
  // malicious one — it only broke a legitimate wallet posting from its popup.
  if (
    publicPortal &&
    (origin.startsWith('chrome-extension://') ||
      origin.startsWith('moz-extension://') ||
      origin.startsWith('safari-web-extension://'))
  ) {
    return true;
  }
  if (allowOrigins.includes(origin)) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  } catch {
    return false;
  }
}

/** Reflect the validated origin (NEVER `*`), so only allowed browser origins can read responses. On a public
 *  portal every real origin is validated (see `isAllowedOrigin`), so the caller's Origin is reflected. */
function applyCors(res: ServerResponse, origin: string | undefined, allowOrigins: string[], publicPortal = false): void {
  if (origin && isAllowedOrigin(origin, allowOrigins, publicPortal)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hearthold-Session, X-Hearthold-Poll-Secret');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
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
  // Per-server (not module-global — one Warden's events never reach another's console), and each client
  // carries its resolved session DID so `emit` can scope frames to their audience.
  const sse = new Set<{ res: ServerResponse; did?: string }>();

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  const allowOrigins = options.allowOrigins ?? [];
  const publicPortal = options.publicPortal ?? false;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

    // Anti-DNS-rebinding: refuse a request whose Host isn't loopback / the bound host / an allowed origin.
    // This check is UNCHANGED on a public portal — it still binds to the portal's own host.
    if (!isAllowedHost(req.headers.host, host, allowOrigins)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden: host not allowed' }));
      return;
    }
    // Anti-CSRF: refuse a browser request from a disallowed origin outright (not just unreadable via CORS).
    // On a public portal (BYO-wallet) this admits any real origin and refuses only opaque `null` — the Origin
    // is not the boundary there; the signed challenge/response + per-login poll secret are.
    if (!isAllowedOrigin(origin, allowOrigins, publicPortal)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden: origin not allowed' }));
      return;
    }
    // CORS reflects the validated origin (never `*`) for every subsequent response on this request.
    applyCors(res, origin, allowOrigins, publicPortal);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname;

    // SSE stream — clients subscribe here for live events.
    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      const hdr = req.headers['x-hearthold-session'];
      const did = options.resolveSession?.(Array.isArray(hdr) ? hdr[0] : hdr);
      const client = { res, did };
      sse.add(client);
      req.on('close', () => sse.delete(client));
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
      // A route may carry an HTTP status on the thrown error (e.g. UnauthorizedError → 401); default 400.
      const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 400;
      sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  server.listen(options.port, host, () => options.onListening?.(options.port));

  return {
    port: options.port,
    emit(type: string, data: unknown, audience?: EventAudience): void {
      const frame = `data: ${JSON.stringify({ type, at: new Date().toISOString(), data })}\n\n`;
      for (const client of sse) {
        // Deliver iff: broadcast (no audience), or the frame is shared, or this client owns it. A member
        // never receives another member's activity frames (Fable amendment 3 — metadata is a disclosure).
        const deliver = !audience || audience.scope === 'shared' || (!!audience.owner && client.did === audience.owner);
        if (deliver) client.res.write(frame);
      }
    },
    clientCount: () => sse.size,
    close(): void {
      for (const client of sse) client.res.end();
      sse.clear();
      server.close();
    },
  };
}
