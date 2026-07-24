/**
 * Sphere selection safety.
 *
 * Keymaster addresses exactly one Gatekeeper at a time (one `config.nodeUrl` → one `GatekeeperClient`) and
 * on one registry (`config.registry`), and it is BLIND to which — nothing in its API says "here is the node
 * you are about to publish to." Publication is IRREVERSIBLE. So a misconfiguration (a wrong `HEARTHOLD_NODE_URL`,
 * a typo'd registry) publishes to the WRONG sphere with no recovery — the worst failure mode we have, and
 * until now nothing prevented it.
 *
 * This module makes every publish NAME its intended sphere and fail CLOSED on mismatch:
 *   - A `Sphere` is a named target: the (Gatekeeper URL, registry) a sphere's operations live on.
 *   - `publishToSphere(sphere, …)` REQUIRES a sphere — you cannot publish without naming one (structural:
 *     an unnamed-sphere publish is a type error, not a runtime hope).
 *   - Before the op runs, `assertOnSphere` checks the ACTIVE handle/config actually IS that sphere, and
 *     THROWS on any mismatch — so nothing is published to the wrong place; the op never executes.
 *
 * Reads are deliberately NOT gated: ambient/config-inherited targeting is fine for resolution (there is no
 * irreversibility to protect against). Only publishes must name their sphere.
 *
 * NOTE (out of scope, flagged not fixed): the Gatekeeper serves unauthenticated GET reads
 * (`docs/DRAWBRIDGE-GROUNDING.md`, finding 1). That is Archon/deployment server-side work; Hearthold is a
 * client here. This module is about not WRITING to the wrong sphere, not about the read surface.
 */

import type { HearthholdConfig } from './config.js';
import type { KeymasterHandle } from './keymaster.js';

/** A named publication target: the Gatekeeper + registry a sphere's operations are anchored on. */
export interface Sphere {
  /** Human-facing id for messages/audit, e.g. 'home', 'hatpro', 'family'. Not used for matching. */
  id: string;
  /** The Gatekeeper base URL this sphere lives on (matched against the active handle/config, trailing slash ignored). */
  nodeUrl: string;
  /** The registry namespace this sphere anchors on (matched exactly against the active config). */
  registry: string;
}

/** Thrown when a publish names a sphere the active Gatekeeper/registry is NOT. Fail closed — nothing published. */
export class SphereMismatchError extends Error {
  constructor(
    readonly sphere: Sphere,
    readonly active: { nodeUrl: string; registry: string; clientUrl?: string },
    detail: string,
  ) {
    super(
      `refusing to publish to sphere '${sphere.id}': ${detail}. ` +
        `Named sphere = { nodeUrl: ${sphere.nodeUrl}, registry: ${sphere.registry} }; ` +
        `active = { nodeUrl: ${active.nodeUrl}, registry: ${active.registry}` +
        (active.clientUrl ? `, client: ${active.clientUrl}` : '') +
        ` }. Point HEARTHOLD_NODE_URL/HEARTHOLD_REGISTRY at the intended sphere, or pass the sphere it is.`,
    );
    this.name = 'SphereMismatchError';
  }
}

/** The sphere this node currently IS, derived from config. Use it to name "publish to my own sphere". */
export function localSphere(config: HearthholdConfig, id = 'local'): Sphere {
  return { id, nodeUrl: config.nodeUrl, registry: config.registry };
}

/** Trailing-slash-insensitive URL compare (the client and config may differ only by a trailing '/'). */
function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * Assert the ACTIVE gatekeeper/registry is the named sphere; THROW `SphereMismatchError` otherwise. This is
 * the fail-closed gate: it runs before any publish, so a mismatch means nothing left the process. When a
 * `handle` is given, the check is defence-in-depth — it also compares the live gatekeeper client's URL, so a
 * config that drifted from the handle it built is caught too.
 */
export function assertOnSphere(sphere: Sphere, config: HearthholdConfig, handle?: KeymasterHandle): void {
  const clientUrl = handle?.gatekeeper?.url;
  const active = { nodeUrl: config.nodeUrl, registry: config.registry, clientUrl };

  if (sphere.registry !== config.registry) {
    throw new SphereMismatchError(sphere, active, `registry mismatch (active registry is '${config.registry}')`);
  }
  if (!sameUrl(sphere.nodeUrl, config.nodeUrl)) {
    throw new SphereMismatchError(sphere, active, `node URL mismatch (active config node is '${config.nodeUrl}')`);
  }
  if (clientUrl && !sameUrl(sphere.nodeUrl, clientUrl)) {
    throw new SphereMismatchError(sphere, active, `live Keymaster client points at '${clientUrl}', not this sphere`);
  }
}

/**
 * The sanctioned publish entrypoint: run `op` ONLY after asserting the active Gatekeeper is `sphere`. `op`
 * receives the sphere so it anchors on the sphere's registry (`{ registry: sphere.registry }`) rather than
 * an ambient default. Because `sphere` is a required parameter, a publish that does not name a sphere is a
 * compile error — the structural half of the guarantee; the assertion is the runtime, fail-closed half.
 */
export async function publishToSphere<T>(
  sphere: Sphere,
  config: HearthholdConfig,
  op: (sphere: Sphere) => Promise<T>,
  opts: { handle?: KeymasterHandle } = {},
): Promise<T> {
  assertOnSphere(sphere, config, opts.handle);
  return op(sphere);
}
