/**
 * e2e: EMISSARY MODULE RUNTIME — compose capability modules on the runtime and serve them (docs/emissary-modules.md).
 *
 * Proves the first module end-to-end against the live node:
 *   1. Two modules (`introspect` + a `demo`) compose on ONE Emissary runtime; both routes serve from one
 *      control server built from `emissary.routes()`.
 *   2. `GET /api/introspect` reports the real identity, the **enumerable loadout + manifest** (the design's
 *      "explicit powers" thesis), and the **bound node's capabilities** (discovery, didcomm:true).
 *   3. A route collision is refused at COMPOSE time (load-load error, never silent last-writer-wins).
 *
 * Isolated data root; run:  npm run e2e:emissary-module
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  startControlServer,
  type ControlServer,
} from '@hearthold/core';
import { Emissary, type CapabilityModule } from '@hearthold/emissary/module';
import { introspectModule } from '@hearthold/emissary/modules/introspect';

const PORT = 45219;
let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

async function main(): Promise<void> {
  const base = loadConfig();
  const config = { ...base, dataRoot: join(base.dataRoot, 'module-e2e') };

  step('Provision an Emissary identity');
  const km = await openKeymaster('emissary', config, 'hearthold-module-e2e');
  const id = await ensureIdentity(km, config);
  check('identity provisioned', Boolean(id.did));

  step('Compose: introspect + a demo module on one runtime');
  const demo: CapabilityModule = {
    name: 'demo',
    httpRoutes: { 'GET /api/demo': async () => ({ demo: true }) },
    messageHandlers: { 'hearthold/demo-ping': async () => null },
  };
  const emissary = new Emissary().use(introspectModule()).use(demo);
  await emissary.init({ did: id.did, name: IDENTITY_NAME.emissary, nodeUrl: config.nodeUrl });
  check('loadout is [introspect, demo]', JSON.stringify(emissary.loadout()) === JSON.stringify(['introspect', 'demo']));

  step('A colliding route is refused at COMPOSE time');
  let refused = false;
  try {
    new Emissary()
      .use(introspectModule())
      .use({ name: 'clash', httpRoutes: { 'GET /api/introspect': async () => ({}) } });
  } catch {
    refused = true;
  }
  check('two modules cannot claim GET /api/introspect', refused);

  step('Serve the merged routes and probe them');
  let server: ControlServer | undefined;
  try {
    server = startControlServer({ port: PORT, host: '127.0.0.1', routes: emissary.routes() });
    await new Promise((r) => setTimeout(r, 200)); // let it bind

    const res = await fetch(`http://127.0.0.1:${PORT}/api/introspect`);
    const j = (await res.json()) as {
      ok?: boolean;
      identity?: { did?: string };
      nodeCapabilities?: { didcomm?: boolean } | null;
      loadout?: string[];
      manifest?: Array<{ name: string; routes: string[]; messageTypes: string[] }>;
    };
    check('GET /api/introspect → ok', j.ok === true);
    check('reports the real identity DID', j.identity?.did === id.did);
    check('reports node capabilities (live node: didcomm:true)', j.nodeCapabilities?.didcomm === true);
    check('loadout is enumerable via the API', JSON.stringify(j.loadout) === JSON.stringify(['introspect', 'demo']));
    const introMan = j.manifest?.find((m) => m.name === 'introspect');
    check('manifest names the introspect route', JSON.stringify(introMan?.routes) === JSON.stringify(['GET /api/introspect']));
    const demoMan = j.manifest?.find((m) => m.name === 'demo');
    check('manifest names the demo message type', JSON.stringify(demoMan?.messageTypes) === JSON.stringify(['hearthold/demo-ping']));

    const demoRes = await fetch(`http://127.0.0.1:${PORT}/api/demo`);
    const dj = (await demoRes.json()) as { ok?: boolean; demo?: boolean };
    check('the demo module route also serves from the same runtime', dj.ok === true && dj.demo === true);

    const missing = await fetch(`http://127.0.0.1:${PORT}/api/nope`);
    check('an unknown route is 404', missing.status === 404);
  } finally {
    server?.close();
  }

  process.stdout.write(failures === 0 ? '\nPASS\n' : `\nFAIL (${failures})\n`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
