/**
 * `introspect` — the first Emissary capability module (`docs/emissary-modules.md`).
 *
 * Read-only self-description: what this Emissary IS (identity), what powers it carries (the loadout +
 * per-module manifest), and what the node it is bound to actually offers (capability discovery, @didcid
 * 0.6.3). This is the module that makes the design's central promise concrete — an agent's powers are
 * **explicit and enumerable**, not implicit in its code paths — and it gives the node-capability probe a
 * home on the control plane.
 *
 * Holds no authority and touches nothing: safe to load on every Emissary as a baseline. `GET /api/introspect`.
 */
import { discoverNodeCapabilities, type NodeCapabilities } from '@hearthold/core';

import type { CapabilityModule, ModuleContext } from '../module.js';

/** The shape returned by `GET /api/introspect` (wrapped by the control server as `{ ok: true, ...this }`). */
export interface IntrospectReport {
  identity: { did: string; name: string };
  nodeUrl: string;
  /** The bound node's advertised capabilities, or `null` if unreachable / no endpoint (permissive unknown). */
  nodeCapabilities: NodeCapabilities | null;
  /** The names of every loaded module — the enumerable loadout. */
  loadout: string[];
  /** What each loaded module owns (routes + message types). */
  manifest: ReturnType<ModuleContext['manifest']>;
}

export function introspectModule(): CapabilityModule {
  let ctx: ModuleContext | undefined;
  return {
    name: 'introspect',
    init(c) {
      ctx = c;
    },
    httpRoutes: {
      'GET /api/introspect': async (): Promise<IntrospectReport> => {
        if (!ctx) throw new Error('introspect: module not initialised');
        // Permissive probe — `null` on an unreachable node or one with no capabilities endpoint; never throws.
        const nodeCapabilities = await discoverNodeCapabilities(ctx.nodeUrl);
        return {
          identity: { did: ctx.did, name: ctx.name },
          nodeUrl: ctx.nodeUrl,
          nodeCapabilities,
          loadout: ctx.loadout(),
          manifest: ctx.manifest(),
        };
      },
    },
  };
}
