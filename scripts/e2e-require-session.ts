/**
 * e2e: REQUIRE-SESSION — the anonymous Sovereign fallback is retired when require-session is on.
 *
 * Exercises the real `startControlServer` 401 path and the exact `effectiveViewer` guard the Warden wires:
 * scoped routes throw `UnauthorizedError` (→ HTTP 401) when there is no proven session; open routes
 * (`status`) stay reachable and drop vault metadata pre-login; a generic error still yields 400; and with
 * require-session off, the single-Sovereign fallback is unchanged.
 *
 *   node --experimental-strip-types scripts/e2e-require-session.ts   (no Archon node needed — pure HTTP)
 */
import http from 'node:http';

import { startControlServer, UnauthorizedError } from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const PORT = 4399;
const sessions = new Map<string, string>([['valid-token', 'did:cid:member']]);
const SOVEREIGN = 'did:cid:sovereign';
let requireSession = true;

const tokenOf = (req: http.IncomingMessage): string | null => {
  const h = req.headers['x-hearthold-session'];
  return Array.isArray(h) ? (h[0] ?? null) : (h ?? null);
};
// The exact guard control.ts wires: session member, else 401 when require-session, else Sovereign fallback.
const effectiveViewer = (req: http.IncomingMessage): string | undefined => {
  const did = sessions.get(tokenOf(req) ?? '');
  if (did) return did;
  if (requireSession) throw new UnauthorizedError();
  return SOVEREIGN;
};

function get(path: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path, headers: token ? { 'x-hearthold-session': token } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
      },
    );
    req.on('error', reject);
  });
}

async function main(): Promise<void> {
  const server = await new Promise<ReturnType<typeof startControlServer>>((resolve) => {
    const s = startControlServer({
      port: PORT,
      routes: {
        // Open — but drops vault metadata pre-login on a require-session node.
        'GET /api/status': async ({ req }) => {
          const did = sessions.get(tokenOf(req as http.IncomingMessage) ?? '');
          return requireSession && !did
            ? { status: { serving: true } }
            : { status: { serving: true, artefactCount: 15, delegationCount: 2, sessionDid: did } };
        },
        // Scoped — funnels through effectiveViewer, which throws 401 when require-session + no session.
        'GET /api/snapshot': async ({ req }) => ({ viewer: effectiveViewer(req as http.IncomingMessage), vault: [] }),
        // A generic failure must still be 400, not 401.
        'GET /api/boom': async () => {
          throw new Error('something else went wrong');
        },
      },
      onListening: () => resolve(s),
    });
  });

  try {
    step('require-session ON: scoped reads demand a proven session');
    const anon = await get('/api/snapshot');
    check('unauthenticated GET /api/snapshot → 401', anon.status === 401);
    check('the 401 body says log in (ok:false)', anon.body.ok === false && /log in/i.test(String(anon.body.error)));
    const authed = await get('/api/snapshot', 'valid-token');
    check('GET /api/snapshot with a valid session → 200, scoped to the member', authed.status === 200 && (authed.body as { viewer?: string }).viewer === 'did:cid:member');
    const forged = await get('/api/snapshot', 'not-a-real-token');
    check('a forged/expired token → 401 (no session resolved)', forged.status === 401);

    step('Open routes still answer so a member can log in');
    const status = await get('/api/status');
    check('unauthenticated GET /api/status → 200 (liveness)', status.status === 200);
    const s = (status.body as { status?: Record<string, unknown> }).status ?? {};
    check('pre-login status omits vault metadata (no artefactCount/delegationCount)', s.artefactCount === undefined && s.delegationCount === undefined && s.serving === true);
    const statusAuthed = await get('/api/status', 'valid-token');
    check('authenticated status includes the counts', (statusAuthed.body as { status?: { artefactCount?: number } }).status?.artefactCount === 15);

    step('A generic error stays 400 (only missing-session is 401)');
    check('GET /api/boom → 400, not 401', (await get('/api/boom')).status === 400);

    step('require-session OFF: the single-Sovereign fallback is unchanged');
    requireSession = false;
    const backcompat = await get('/api/snapshot');
    check('unauthenticated GET /api/snapshot → 200, served as the Sovereign', backcompat.status === 200 && (backcompat.body as { viewer?: string }).viewer === SOVEREIGN);
  } finally {
    server.close();
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ require-session: identity proven for every scoped read; open routes still let a member in; off = unchanged\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-require-session: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
