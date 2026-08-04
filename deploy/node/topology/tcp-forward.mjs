// Raw TCP pass-through forwarder. Used to bridge the Warden/Signet control plane, which is a full
// command API (POST, SSE event stream) — so we forward bytes, not filter paths (unlike gatekeeper-guard).
//   LISTEN=0.0.0.0:4390 TARGET=127.0.0.1:4310 node tcp-forward.mjs
// Two uses in docker-compose.control.yml:
//   (1) INSIDE the warden container: lift the daemon's loopback bind (127.0.0.1:4310) onto the container
//       interface (0.0.0.0:4390) so a sidecar can reach it — a stopgap until Hearthold adds a bind-host env.
//   (2) the BRIDGE sidecar: publish host 127.0.0.1:4310 -> warden-console:4390, so the local browser reaches it.
import net from 'node:net';
const [lh, lp] = (process.env.LISTEN || '0.0.0.0:4390').split(':');
const [th, tp] = (process.env.TARGET || '127.0.0.1:4310').split(':');
net.createServer((c) => {
  const up = net.connect(+tp, th);
  c.pipe(up); up.pipe(c);
  c.on('error', () => up.destroy());
  up.on('error', () => c.destroy());
}).listen(+lp, lh, () => console.log(`tcp-forward ${lh}:${lp} -> ${th}:${tp}`));
