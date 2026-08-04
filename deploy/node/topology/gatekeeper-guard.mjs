// Aegis gatekeeper guard — a resolution-only reverse proxy that seals a REACHABLE node's admin
// surface at the deployment layer. Hearthold's PrivateGatekeeper removes import at the TYPE layer
// (binds Hearthold code); this shuts the raw HTTP path BELOW it — the one a raw `curl .../dids/import`
// (or a malicious peer) would use to shove foreign ops into your private DB.
//
// Policy (default, GUARD_MODE=resolver): a peer may RESOLVE (the fallback path) and check health —
// nothing else. Blocked with 403: all writes/admin (dids/import, events/process, reset), DID
// enumeration (POST /dids/), and bulk export (dids/export, /1.0/identifiers/<did>/data — the
// encrypted-content leak). GUARD_MODE=private additionally blocks resolution — a truly private node
// serves no peer, so publish the guard in `private` mode (or don't publish the port at all).
//
//   docker run ... -e GK=gatekeeper:4224 -e GUARD_MODE=resolver node gatekeeper-guard.mjs   # :4324
import http from 'node:http';

const [GK_HOST, GK_PORT] = (process.env.GK || 'gatekeeper:4224').split(':');
const MODE = process.env.GUARD_MODE || 'resolver';
const PORT = +(process.env.PORT || 4324);

// Allowlist: exact, GET-only, read paths. Everything not matched is refused.
const RESOLVE_READS = [
  /^\/api\/v1\/ready\/?$/,
  /^\/api\/v1\/registries\/?$/,
  // Single path segment only (the peer's fallback client URL-encodes the DID, e.g. did%3Acid%3A…).
  // `[^/]+` matches literal OR %-encoded DIDs but NOT a second segment — so /1.0/identifiers/<did>/data
  // (the encrypted-content leak) stays blocked.
  /^\/api\/v1\/did\/[^/]+\/?$/,                    // resolve a single DID (the doc a peer needs)
  /^\/1\.0\/identifiers\/[^/]+\/?$/,               // universal-resolver resolve — the fallback path
];
const HEALTH_ONLY = [/^\/api\/v1\/ready\/?$/];
const ALLOW = MODE === 'private' ? HEALTH_ONLY : RESOLVE_READS;

http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  const ok = req.method === 'GET' && ALLOW.some((re) => re.test(path));
  if (!ok) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'sealed: gatekeeper guard permits resolution reads only (no import/admin/enumerate/export)' }));
    return;
  }
  const up = http.request(
    { host: GK_HOST, port: +GK_PORT, path: req.url, method: 'GET', headers: { ...req.headers, host: `${GK_HOST}:${GK_PORT}` } },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
  );
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(PORT, () => console.log(`aegis gatekeeper-guard :${PORT} mode=${MODE} -> ${GK_HOST}:${GK_PORT} (resolution-only; import/admin/enumerate/export -> 403)`));
