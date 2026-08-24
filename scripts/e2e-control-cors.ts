/**
 * e2e: CONTROL-PLANE CORS — the control API is unauthenticated-at-transport and loopback-bound, so a
 * wildcard `Access-Control-Allow-Origin: *` was a DNS-rebinding / localhost-CSRF surface. This proves the
 * hardening in `startControlServer`: reflect only an allow-listed origin (never `*`), reject a cross-origin
 * browser request server-side, and refuse a rebound `Host`.
 *
 *   node --experimental-strip-types scripts/e2e-control-cors.ts   (pure HTTP, no Archon node needed)
 */
import http from 'node:http';

import { startControlServer } from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const PORT = 4398;

function req(method: string, headers: Record<string, string>): Promise<{ status: number; acao?: string; ok?: boolean }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/status', method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          acao: res.headers['access-control-allow-origin'] as string | undefined,
          ok: data ? (JSON.parse(data) as { ok?: boolean }).ok : undefined,
        }),
      );
    });
    r.on('error', reject);
    r.end();
  });
}

async function main(): Promise<void> {
  const server = await new Promise<ReturnType<typeof startControlServer>>((resolve) => {
    const s = startControlServer({
      port: PORT,
      allowOrigins: ['https://table.example'], // an explicitly-configured deployed Table
      routes: { 'GET /api/status': async () => ({ status: { serving: true } }) },
      onListening: () => resolve(s),
    });
  });

  const acaos: (string | undefined)[] = [];
  const call = async (label: string, headers: Record<string, string>) => {
    const r = await req('GET', headers);
    acaos.push(r.acao);
    return r;
  };

  try {
    step('Loopback origins (a local Table on any port) and non-browser callers are allowed');
    {
      const r = await call('no Origin (curl/same-origin)', { host: '127.0.0.1' });
      check('no-Origin request → 200, no ACAO reflected', r.status === 200 && r.ok === true && r.acao === undefined);
    }
    {
      const r = await call('Origin http://localhost:5175', { host: '127.0.0.1', origin: 'http://localhost:5175' });
      check('a localhost Table origin → 200, ACAO reflects it (not *)', r.status === 200 && r.acao === 'http://localhost:5175');
    }
    {
      const r = await call('Origin http://127.0.0.1:4310', { host: '127.0.0.1', origin: 'http://127.0.0.1:4310' });
      check('a 127.0.0.1 origin → 200, reflected', r.status === 200 && r.acao === 'http://127.0.0.1:4310');
    }
    {
      const r = await call('configured Origin https://table.example', { host: '127.0.0.1', origin: 'https://table.example' });
      check('an explicitly-allowed origin → 200, reflected', r.status === 200 && r.acao === 'https://table.example');
    }

    step('Cross-origin browser requests are REFUSED server-side (anti-CSRF)');
    {
      const r = await call('Origin https://evil.example', { host: '127.0.0.1', origin: 'https://evil.example' });
      check('a disallowed origin → 403, and NO ACAO (browser cannot read it)', r.status === 403 && r.acao === undefined);
    }
    {
      const r = await call('opaque Origin "null"', { host: '127.0.0.1', origin: 'null' });
      check('an opaque origin (sandboxed iframe/file://) → 403', r.status === 403);
    }

    step('A rebound Host is refused (anti-DNS-rebinding — CORS alone does not stop this)');
    {
      const r = await call('Host evil.example (rebound to 127.0.0.1)', { host: 'evil.example' });
      check('a non-loopback Host → 403 forbidden host', r.status === 403);
    }

    step('Preflight OPTIONS reflects an allowed origin');
    {
      const r = await req('OPTIONS', { host: '127.0.0.1', origin: 'http://localhost:3000' });
      acaos.push(r.acao);
      check('OPTIONS from a localhost origin → 204, reflected', r.status === 204 && r.acao === 'http://localhost:3000');
    }

    step('The wildcard is gone everywhere');
    check('no response ever sent Access-Control-Allow-Origin: *', acaos.every((a) => a !== '*'));
  } finally {
    server.close();
  }

  process.stdout.write(
    failures === 0
      ? '\n✓ control-cors: loopback + configured origins reflected; cross-origin and rebound-Host refused; never `*`\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-control-cors: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
