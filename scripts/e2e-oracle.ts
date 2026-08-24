/**
 * e2e: the anonymous ORACLE reader (PR #9) — the portal's public no-wallet `POST /api/kb/ask` contract.
 *
 * Drives `startKbPortalServer` over real HTTP with a STUB transport + stub reader — deterministic, no live
 * node or Ollama. It proves the PORTAL's guards + the oracle's security contract:
 *   (a) pin-enforcement — a caller cannot redirect the oracle at another kbId (rejected before any Warden call);
 *   (b) shared-only + strip — the query it sends carries `scope:'shared'` (so recall can't draw the reader's
 *       own private partition) AND any private citation is stripped defence-in-depth;
 *   (c) re-login-once — a stale-token error triggers exactly one refresh + retry, never a loop;
 *   (d) rate guards — per-IP window + global concurrent cap, both fail closed;
 *   + the route is DISABLED unless an oracle reader is configured (never open by default).
 *
 * NOTE ON SCOPE: this tests the portal CONTRACT. The Warden's enforcement of `scope:'shared'` (that recall
 * actually excludes the caller's own private partition from the ANSWER) is the a3e6df4 change and is warden
 * territory — a warden-level recall test (needs Ollama) is the belt-and-suspenders for that half.
 *
 * Run:  npm run e2e:oracle
 */
import { PROTOCOL_VERSION, type Transport } from '@hearthold/core';
import { startKbPortalServer, type OracleReader } from '@hearthold/emissary/kb-portal-server';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Msg = { type: string; [k: string]: unknown };
type Citation = { artefactId: string; kind: string; observedAt: string; score: number; scope?: 'shared' | 'private' };

interface StubCfg {
  citations?: Citation[];
  answer?: string;
  errorThenOk?: boolean; // first query → session error, then ok (re-login-once path)
  alwaysSessionError?: boolean; // every query → session error (no-loop assertion)
  gate?: Promise<void>; // if set, the query awaits it (concurrency assertion)
}

function makeStub(cfg: StubCfg = {}) {
  const requests: Msg[] = [];
  let logins = 0;
  let queryCount = 0;
  const transport = {
    ready: async () => {},
    serve: async () => () => {},
    keepAlive: () => {},
    request: async (_to: string, msg: Msg): Promise<Msg> => {
      requests.push(msg);
      switch (msg.type) {
        case 'hearthold/kb-login-start':
          logins += 1;
          return { type: 'hearthold/kb-login-challenge', version: PROTOCOL_VERSION, challenge: `chal-${logins}` };
        case 'hearthold/kb-login-complete':
          return {
            type: 'hearthold/kb-session',
            version: PROTOCOL_VERSION,
            token: `tok-${logins}`,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          };
        case 'hearthold/kb-session-request': {
          queryCount += 1;
          if (cfg.gate) await cfg.gate;
          if (cfg.alwaysSessionError || (cfg.errorThenOk && queryCount === 1)) {
            return { type: 'hearthold/kb-error', version: PROTOCOL_VERSION, reason: 'session expired (401)' };
          }
          return {
            type: 'hearthold/kb-result',
            version: PROTOCOL_VERSION,
            action: 'query',
            answer: cfg.answer ?? 'the public answer',
            citations: cfg.citations ?? [],
          };
        }
        default:
          return { type: 'hearthold/kb-error', version: PROTOCOL_VERSION, reason: `unexpected ${msg.type}` };
      }
    },
  } as unknown as Transport;
  return {
    transport,
    requests,
    get logins() {
      return logins;
    },
    get queryCount() {
      return queryCount;
    },
  };
}

const reader = (kbId: string, over: Partial<OracleReader> = {}): OracleReader => ({
  createResponse: async () => 'did:cid:stub-response',
  kbId,
  registry: 'local',
  ...over,
});

let portSeq = 4390;
function startPortal(stub: { transport: Transport }, oracle?: OracleReader) {
  const port = portSeq++;
  const server = startKbPortalServer({
    transport: stub.transport,
    wardenDid: 'did:cid:stub-warden',
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    ...(oracle ? { oracle } : {}),
  });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

async function ask(url: string, body: unknown): Promise<{ ok: boolean; error?: string; answer?: string; citations?: Citation[] }> {
  const res = await fetch(`${url}/api/kb/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => ({ ok: false, error: 'non-json' }))) as {
    ok: boolean;
    error?: string;
    answer?: string;
    citations?: Citation[];
  };
}

async function main(): Promise<void> {
  process.stdout.write('Hearthold anonymous-oracle portal-contract e2e (stub transport; no node/Ollama)\n');

  step('The route is DISABLED unless an oracle is configured (never open by default)');
  {
    const stub = makeStub();
    const { server, url } = startPortal(stub); // no oracle
    try {
      const r = await ask(url, { query: 'hello' });
      check('no-oracle → route reports it is not enabled', r.ok === false && /not enabled/i.test(r.error ?? ''));
      check('no Warden call was made', stub.requests.length === 0);
    } finally {
      server.close();
    }
  }

  step('(a) pin-enforcement — a caller cannot redirect the oracle at another kbId');
  {
    const stub = makeStub();
    const { server, url } = startPortal(stub, reader('city-of-mages'));
    try {
      const r = await ask(url, { query: 'hello', kbId: 'some-other-kb' });
      check('a foreign kbId is refused', r.ok === false && /only for its configured KB/i.test(r.error ?? ''));
      check('refused BEFORE any Warden query (no kb-session-request sent)', !stub.requests.some((m) => m.type === 'hearthold/kb-session-request'));
    } finally {
      server.close();
    }
  }

  step("(b) shared-only + private-strip — the query pins scope:'shared', and a private citation is stripped");
  {
    const stub = makeStub({
      answer: 'the public answer',
      citations: [
        { artefactId: 'a-shared', kind: 'document', observedAt: '2026-01-01', score: 0.9, scope: 'shared' },
        { artefactId: 'a-private', kind: 'document', observedAt: '2026-01-01', score: 0.8, scope: 'private' },
      ],
    });
    const { server, url } = startPortal(stub, reader('city-of-mages'));
    try {
      const r = await ask(url, { query: 'what is the news?' });
      check('it answers', r.ok === true && r.answer === 'the public answer');
      const sreq = stub.requests.find((m) => m.type === 'hearthold/kb-session-request') as Msg | undefined;
      check("the query pins scope:'shared' (recall can't draw the reader's private partition)", sreq?.scope === 'shared' && sreq?.action === 'query');
      const cited = (r.citations ?? []).map((c) => c.artefactId);
      check('the shared citation is returned', cited.includes('a-shared'));
      check('a private citation is stripped (defence in depth)', !cited.includes('a-private'));
    } finally {
      server.close();
    }
  }

  step('(c) re-login-once — a stale token refreshes + retries, then answers');
  {
    const stub = makeStub({ errorThenOk: true, answer: 'answer after relogin' });
    const { server, url } = startPortal(stub, reader('city-of-mages'));
    try {
      const r = await ask(url, { query: 'x' });
      check('a stale-session error triggers a re-login + retry, then answers', r.ok === true && r.answer === 'answer after relogin');
      check('re-logged in exactly once (2 logins: initial + one refresh)', stub.logins === 2);
    } finally {
      server.close();
    }
  }

  step('(c) no loop — a persistent session error surfaces after exactly one retry');
  {
    const stub = makeStub({ alwaysSessionError: true });
    const { server, url } = startPortal(stub, reader('city-of-mages'));
    try {
      const r = await ask(url, { query: 'x' });
      check('a persistent session error is surfaced (not looped)', r.ok === false);
      check('retried at most once — exactly 2 query attempts', stub.queryCount === 2);
    } finally {
      server.close();
    }
  }

  step('(d) per-IP rate guard — the window fails closed');
  {
    const stub = makeStub({ answer: 'ok' });
    const { server, url } = startPortal(stub, reader('city-of-mages', { perIpPerMin: 2 }));
    try {
      const r1 = await ask(url, { query: '1' });
      const r2 = await ask(url, { query: '2' });
      const r3 = await ask(url, { query: '3' });
      check('the first two in the window are allowed', r1.ok === true && r2.ok === true);
      check('the third in the window is refused', r3.ok === false && /rate limit/i.test(r3.error ?? ''));
    } finally {
      server.close();
    }
  }

  step('(d) global concurrent cap — a 2nd in-flight query is refused (protects the model host)');
  {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const stub = makeStub({ answer: 'ok', gate, /* generous per-IP so the cap, not the window, is what bites */ });
    const { server, url } = startPortal(stub, reader('city-of-mages', { maxConcurrent: 1, perIpPerMin: 100 }));
    try {
      const p1 = ask(url, { query: 'a' }); // occupies the single slot, awaiting the gate
      await sleep(80); // let p1's handler reach inFlight += 1
      const r2 = await ask(url, { query: 'b' }); // over the cap → refused
      check('a 2nd concurrent query is refused while the 1st is in flight', r2.ok === false && /busy/i.test(r2.error ?? ''));
      release();
      const r1 = await p1;
      check('the first query completes once released', r1.ok === true);
    } finally {
      server.close();
    }
  }

  process.stdout.write(`\n${failures === 0 ? '✓ anonymous oracle: portal contract holds' : `✗ FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-oracle: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
