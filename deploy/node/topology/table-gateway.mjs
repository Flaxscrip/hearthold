// Aegis Table gateway — a lightweight stand-in for Drawbridge's unified node URL, for a Hearthold
// Table backend that runs WITHOUT Drawbridge (e.g. a kernel-6.19 host where the Lightning stack, and
// thus drawbridge-init's `wait for lightningd`, can't run). Hearthold derives its DIDComm gateway as
// `${HEARTHOLD_NODE_URL}/didcomm` for BOTH sending and reading its own mailbox (keymaster.ts
// fetchDidCommChallenge), so the node URL must serve both the gatekeeper API and the DIDComm relay.
// Route:
//   /didcomm/*  -> the didcomm relay (:4236), STRIPPING the /didcomm prefix (it serves at /api/v1/*)
//   everything  -> the raw gatekeeper (:4224), injecting the admin key (resolve is open; import/
//                  processEvents are admin-gated, which credential/submission handling needs)
import http from 'node:http';
const GK = { host: process.env.GK_HOST || 'gatekeeper', port: +(process.env.GK_PORT || 4224) };
const DC = { host: process.env.DC_HOST || 'didcomm',    port: +(process.env.DC_PORT || 4236) };
const ADMIN = process.env.ADMIN_KEY || '';
const PORT = +(process.env.PORT || 4299);
http.createServer((req, res) => {
  const toDidcomm = req.url.startsWith('/didcomm');
  const t = toDidcomm ? DC : GK;
  const path = toDidcomm ? (req.url.replace(/^\/didcomm/, '') || '/') : req.url;
  const headers = { ...req.headers, host: `${t.host}:${t.port}` };
  if (!toDidcomm && ADMIN) headers['x-archon-admin-key'] = ADMIN;
  const up = http.request({ host: t.host, port: t.port, path, method: req.method, headers },
    r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', e => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(PORT, () => console.log(`aegis table-gateway :${PORT}  /didcomm->%s:%d(strip)  else->%s:%d(+admin)`, DC.host, DC.port, GK.host, GK.port));
