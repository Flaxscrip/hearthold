// aegis didcomm-guard — a filtering reverse-proxy that opens the sealed node's DIDComm MAILBOX and nothing else.
//
// The didcomm relay's whole API IS the mailbox protocol (deliver / challenge / fetch / remove) — there is no
// admin/enumerate/export surface to lock out, unlike the gatekeeper (see gatekeeper-guard.mjs). So this guard's
// job is defense-in-depth, not filtering a rich API:
//   - EXACT path + method allowlist  (future-proofs: if the relay ever grows an admin route, this won't expose it)
//   - inbound-only byte-forward       (the node never gains egress; the guard only relays host -> didcomm)
//   - bind is chosen by the deployer  (publish to 127.0.0.1 for a host-local door; a DMZ net for a peer-facing one)
//
//   DC=didcomm:4236 PORT=4236 node didcomm-guard.mjs
import http from 'node:http';

const [DC_HOST, DC_PORT] = (process.env.DC || 'didcomm:4236').split(':');
const PORT = +(process.env.PORT || 4236);

// The complete, intended mailbox surface — anything else -> 403.
const ALLOW = [
  ['GET',  /^\/health\/?$/],
  ['GET',  /^\/api\/v1\/challenge\/?$/],
  ['POST', /^\/api\/v1\/messages\/?$/],
  ['POST', /^\/api\/v1\/messages\/fetch\/?$/],
  ['POST', /^\/api\/v1\/messages\/remove\/?$/],
  ['POST', /^\/api\/v1\/deliver\/?$/],
];

http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  const ok = ALLOW.some(([m, re]) => req.method === m && re.test(path));
  if (!ok) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'sealed: didcomm guard permits mailbox ops only (health/challenge/messages[/fetch|/remove]/deliver)' }));
    return;
  }
  const up = http.request(
    { host: DC_HOST, port: +DC_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `${DC_HOST}:${DC_PORT}` } },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
  );
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(PORT, '0.0.0.0', () => console.log(`aegis didcomm-guard :${PORT} -> ${DC_HOST}:${DC_PORT} (mailbox ops only; all else 403)`));
