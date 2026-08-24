/**
 * e2e: SPHERE SELECTION SAFETY — a publish must name its intended sphere, and Hearthold refuses (fail
 * closed) if the active Gatekeeper/registry is not that sphere. A misconfiguration must never publish to the
 * wrong sphere — the one irreversible mistake with no recovery.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-sphere-safety.ts
 */
import { join } from 'node:path';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  IDENTITY_NAME,
  localSphere,
  publishToSphere,
  assertOnSphere,
  SphereMismatchError,
  type Sphere,
  type HearthholdConfig,
  type KeymasterHandle,
} from '@hearthold/core';

let failures = 0;
const check = (label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures += 1;
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

// STRUCTURAL guarantee (enforced by the build, not this run): a publish that does not name a sphere is a
// TYPE ERROR. This never executes — it exists so `tsc` fails if the sphere argument is ever made optional.
async function _structuralGuard(config: HearthholdConfig): Promise<void> {
  // @ts-expect-error SPHERE SAFETY: publishToSphere requires an explicit Sphere target — an unnamed publish does not compile
  await publishToSphere(config, async () => 1);
}
void _structuralGuard;

async function main(): Promise<void> {
  const base = loadConfig();
  const config: HearthholdConfig = { ...base, dataRoot: join(base.dataRoot, 'sphere') };
  process.stdout.write(`SPHERE SELECTION SAFETY\n  active node: ${config.nodeUrl}\n  active registry: ${config.registry}\n`);

  step('Provision a Warden on the active sphere');
  const warden: KeymasterHandle = await openKeymaster('warden', config, 'hearthold-sphere-e2e');
  await ensureIdentity(warden, config);
  await warden.keymaster.setCurrentId(IDENTITY_NAME.warden);
  const km = warden.keymaster;

  // The sphere this node IS, named explicitly.
  const home = localSphere(config, 'home');

  step('MATCH — publishToSphere(home) proceeds and anchors on the sphere’s registry');
  const did = await publishToSphere(home, config, (s) => km.createAsset({ note: 'hello sphere' }, { registry: s.registry }), { handle: warden });
  check('publish to the matching sphere proceeds and returns a did:cid', typeof did === 'string' && did.startsWith('did:'));

  step('MISMATCH (registry) — a publish naming a sphere on a different registry is REFUSED, and nothing is published');
  const wrongRegistry: Sphere = { id: 'other-registry', nodeUrl: config.nodeUrl, registry: config.registry === 'local' ? 'hyperswarm' : 'local' };
  {
    let opRan = false;
    let threw: unknown;
    try {
      await publishToSphere(wrongRegistry, config, async (s) => {
        opRan = true; // must NEVER flip — the assertion fails first (fail closed)
        return km.createAsset({ note: 'should not exist' }, { registry: s.registry });
      }, { handle: warden });
    } catch (e) {
      threw = e;
    }
    check('the publish is refused (SphereMismatchError)', threw instanceof SphereMismatchError);
    check('FAIL CLOSED: the publish op never ran (nothing anchored)', opRan === false);
  }

  step('MISMATCH (node URL) — a publish naming a sphere on a different Gatekeeper is REFUSED');
  const wrongNode: Sphere = { id: 'elsewhere', nodeUrl: 'http://not-this-node.invalid:4222', registry: config.registry };
  {
    let opRan = false;
    let threw: unknown;
    try {
      await publishToSphere(wrongNode, config, async () => {
        opRan = true;
        return 'nope';
      }, { handle: warden });
    } catch (e) {
      threw = e;
    }
    check('the publish is refused (SphereMismatchError)', threw instanceof SphereMismatchError);
    check('FAIL CLOSED: the publish op never ran', opRan === false);
  }

  step('READS stay ambient — resolution needs no named sphere (no irreversibility to protect)');
  // A read on ambient config just works; assertOnSphere is only for publishes. Prove a resolve succeeds
  // without going through publishToSphere at all.
  const resolved = await km.resolveDID(IDENTITY_NAME.warden);
  check('an ambient read (resolveDID) succeeds with no sphere named', Boolean(resolved?.didDocument?.id));
  // And assertOnSphere for the true active sphere is a no-op (does not throw) — sanity on the matcher.
  let matchThrew = false;
  try {
    assertOnSphere(home, config, warden);
  } catch {
    matchThrew = true;
  }
  check('assertOnSphere accepts the genuinely-active sphere (no false positives)', matchThrew === false);

  process.stdout.write(
    failures === 0
      ? '\n✓ sphere-safety: publishes name their sphere; a mismatch fails closed; reads stay ambient\n'
      : `\n✗ ${failures} check(s) off-target\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-sphere-safety: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
