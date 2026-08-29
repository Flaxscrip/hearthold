/**
 * The Emissary's Knowledge Portal — HTTP → DIDComm bridge, assembled as a loadout on the Emissary module
 * runtime (`kb-relay` + optional `oracle`).
 *
 * The member's keys never touch the portal. Login is challenge/response (the archon.social pattern): the
 * browser gets a challenge from the Warden (via this Emissary), the member's wallet/Signet responds
 * out-of-band, and the WARDEN mints a session. This server only relays — it authenticates and authorizes
 * nothing (the Warden does, end-to-end). It holds no secret, bar the oracle's read-only reader.
 *
 * The route logic lives in `modules/kb-web.ts` (`kbRelayModule`, `oracleModule`); this file wires the
 * transport, the held reader, CORS, and the HTTP server. Contrast the doorman (`modules/doorman.ts`), where
 * the EMISSARY authenticates the visitor itself — the pattern for a SEALED Warden that can't resolve its
 * members. Same runtime, different skill; a deployment composes the web face it needs.
 */

import { startControlServer, type ControlServer, type Transport } from '@hearthold/core';

import { Emissary } from './module.js';
import { makeHeldReader } from './held-reader.js';
import { kbRelayModule, oracleModule } from './modules/kb-web.js';

/**
 * The read-only ORACLE reader that powers anonymous (no-wallet) queries. The Warden requires a verified
 * identity for every query — "identity proven, never asserted-by-absence" — so to serve a public
 * "ask the chronicle" box the portal holds ONE read-only member and answers anonymous visitors AS it,
 * pinned to `kbId` and (by that member's read authority) the shared chronicle. This is the single secret
 * this otherwise relay-only server holds: a read-only member on a PUBLIC KB, with no write or grant power.
 */
export interface OracleReader {
  /** Sign a Warden login challenge with the reader's keymaster — the portal self-drives the reader's login. */
  createResponse(challenge: string, opts?: { registry?: string }): Promise<string>;
  /** The KB this oracle answers for. Every anonymous ask is pinned to it; a caller cannot redirect it. */
  kbId: string;
  /** Registry for the reader's login response — must match the Warden's. */
  registry: string;
  /** Per-IP requests per minute for the anonymous route (default 8). */
  perIpPerMin?: number;
  /** Global cap on concurrent anonymous queries — protects the model host, the scarce resource (default 3). */
  maxConcurrent?: number;
}

export interface KbPortalOptions {
  transport: Transport;
  wardenDid: string;
  port: number;
  /** Bind host. Default loopback; set to 0.0.0.0 / a tailnet address to expose the portal publicly. */
  host?: string;
  /** The Emissary's PUBLIC base URL — baked into the challenge callback the wallet POSTs to. */
  publicUrl: string;
  /** Extra browser origins allowed to call the portal, beyond its own public origin — e.g. the Signet
   *  wallet, which lives on a SEPARATE origin and POSTs the login callback here (its request is otherwise
   *  refused by CORS, breaking wallet login). An allowlist, never `*`. */
  allowOrigins?: string[];
  /** Supply a read-only oracle reader to enable the anonymous (no-wallet) `POST /api/kb/ask` route. */
  oracle?: OracleReader;
}

export function startKbPortalServer(opts: KbPortalOptions): ControlServer {
  const { transport, wardenDid, publicUrl } = opts;
  // The Emissary is request-only (it relays to the Warden). Keep its mailbox reader continuously alive so
  // it never goes idle between logins — an idle reader lets the relay session go stale and later replies
  // silently vanish (symptom: works for a while, then `transport: timeout` until restart).
  transport.keepAlive?.();

  // Compose the web face from skills on the runtime: member-login relay, plus the anonymous oracle if a
  // reader was supplied. (Neither module has an `init` hook, so `routes()` is the only merge point needed.)
  const runtime = new Emissary().use(kbRelayModule({ transport, wardenDid, publicUrl }));
  if (opts.oracle) {
    const o = opts.oracle;
    const reader = makeHeldReader({
      transport,
      wardenDid,
      kbId: o.kbId,
      createResponse: o.createResponse,
      registry: o.registry,
      callbackUrl: `${publicUrl}/api/kb/ask`,
    });
    runtime.use(
      oracleModule({
        reader,
        kbId: o.kbId,
        ...(o.perIpPerMin !== undefined ? { perIpPerMin: o.perIpPerMin } : {}),
        ...(o.maxConcurrent !== undefined ? { maxConcurrent: o.maxConcurrent } : {}),
      }),
    );
  }

  // The KB portal is a DELIBERATELY-public Mage (fronted by nginx at `publicUrl`), so it must allow its own
  // public origin/host — but still not `*`. Requests from its own UI (Origin/Host = publicUrl) and
  // non-browser callers (no Origin) are allowed; other browser origins are refused. Add more via a
  // deployment override if a third-party browser client ever needs it.
  const portalOrigins = (() => {
    const own = (() => {
      try {
        return [new URL(publicUrl).origin];
      } catch {
        return [];
      }
    })();
    // Plus any origins a deployment opts into (e.g. a Signet wallet on its own origin). Still an allowlist.
    return [...new Set([...own, ...(opts.allowOrigins ?? [])])];
  })();

  return startControlServer({
    port: opts.port,
    host: opts.host,
    allowOrigins: portalOrigins,
    // A deliberately-public Mage reached by bring-your-own-wallet clients (browser add-on with per-install
    // extension origins, mobile/desktop Signets). The Origin allowlist can't enumerate those and isn't the
    // security boundary here — the signed challenge/response + the per-login poll secret are. So accept any
    // real origin (opaque `null` still refused); the Host anti-rebinding check still binds to this portal.
    publicPortal: true,
    routes: runtime.routes(),
    onListening: (p) =>
      process.stdout.write(
        `KB Portal (Emissary web face) on http://${opts.host ?? '127.0.0.1'}:${p}\n` +
          `  public URL:  ${publicUrl}\n  relaying to Warden: ${wardenDid.slice(0, 28)}…\n` +
          `  skills:      ${runtime.loadout().join(', ')}\n` +
          `  login: challenge/response (keys stay in the member's wallet/Signet); the Emissary only carries\n`,
      ),
  });
}
