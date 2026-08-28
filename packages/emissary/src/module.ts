/**
 * The Emissary runtime + capability-module seam (`docs/emissary-modules.md`).
 *
 * The Emissary began as one job (witnessing observations home) and grew several — proof relay, KB traffic,
 * the KB portal. Rather than a grab-bag, we give it a shape: a tiny **runtime** (this file) plus
 * **capability modules** that compose. A deployment is a chosen set of modules — same runtime, different
 * powers — and, importantly, an agent's powers become **explicit and enumerable** (see `introspect`), not
 * implicit in code paths.
 *
 * This is deliberately NOT a plugin framework — just a clean registry with collision-checking and two
 * merge points that plug into the infrastructure already used by `runEmissaryControl`:
 *   - `routes()`   → a `Record<"GET /api/x", ControlHandler>` for `startControlServer`;
 *   - `handler()`  → one `RequestHandler` that dispatches by DIDComm message `type`, for `Transport.serve`.
 * Existing capabilities migrate onto it incrementally; nothing here disturbs the working control plane.
 */
import type { ControlHandler, RequestHandler, Transport, HearthholdMessage } from '@hearthold/core';

/** What a module owns — its enumerable surface. Reported by the `introspect` module. */
export interface ModuleManifest {
  name: string;
  /** HTTP control-plane route keys this module claims (e.g. `"GET /api/introspect"`). */
  routes: string[];
  /** DIDComm message types this module handles. */
  messageTypes: string[];
}

/** Injected into each module at `init` — its window onto the identity, the node, and the loadout. */
export interface ModuleContext {
  /** The Emissary's own `did:cid`. */
  did: string;
  /** The Emissary's wallet id name. */
  name: string;
  /** The Archon node this Emissary is bound to (Drawbridge on :4222). */
  nodeUrl: string;
  /** The DIDComm transport seam, when the runtime is serving over DIDComm (absent for HTTP-only setups). */
  transport?: Transport;
  /** The names of every module loaded on this runtime — the enumerable loadout. */
  loadout: () => string[];
  /** The full manifest of every loaded module (names + routes + message types). */
  manifest: () => ModuleManifest[];
}

/**
 * A self-contained unit of Emissary capability. Registers the DIDComm message types it handles, any HTTP
 * routes it exposes, and its own setup; modules do not reference each other — they compose only through the
 * runtime. Wrap a proven Keymaster/core capability, give it a DIDComm and/or HTTP face, attach its policy.
 */
export interface CapabilityModule {
  /** Plain and specific: `"introspect"`, `"capture"`, `"query"`, `"proof-relay"`, … Unique per runtime. */
  readonly name: string;
  /** HTTP control-plane routes, keyed `"GET /api/foo"` — merged into the control server. */
  readonly httpRoutes?: Record<string, ControlHandler>;
  /** DIDComm message handlers, keyed by the message `type` they handle. */
  readonly messageHandlers?: Record<string, RequestHandler>;
  /** One-time setup with access to identity/transport/loadout. Runs once, in `use()` order, at `init()`. */
  init?(ctx: ModuleContext): Promise<void> | void;
}

/**
 * The runtime. `use()` composes modules (refusing name / route / message-type collisions up front, so a
 * conflict is a load-time error, never a silent last-writer-wins); `init()` wires them once; `routes()` and
 * `handler()` expose the merged surfaces to the existing control-server / transport infrastructure.
 */
export class Emissary {
  private readonly mods: CapabilityModule[] = [];
  private readonly routeOwners = new Map<string, string>();
  private readonly typeOwners = new Map<string, string>();
  private initialised = false;

  /** Register a module. Throws on a duplicate name, or a route / message-type already claimed by another. */
  use(module: CapabilityModule): this {
    if (this.initialised) throw new Error(`Emissary: cannot add module '${module.name}' after init()`);
    if (this.mods.some((m) => m.name === module.name)) {
      throw new Error(`Emissary: duplicate module name '${module.name}'`);
    }
    for (const key of Object.keys(module.httpRoutes ?? {})) {
      const prev = this.routeOwners.get(key);
      if (prev) throw new Error(`Emissary: HTTP route '${key}' claimed by both '${prev}' and '${module.name}'`);
    }
    for (const type of Object.keys(module.messageHandlers ?? {})) {
      const prev = this.typeOwners.get(type);
      if (prev) throw new Error(`Emissary: message type '${type}' claimed by both '${prev}' and '${module.name}'`);
    }
    // Commit only after all checks pass, so a rejected module leaves no partial registration.
    for (const key of Object.keys(module.httpRoutes ?? {})) this.routeOwners.set(key, module.name);
    for (const type of Object.keys(module.messageHandlers ?? {})) this.typeOwners.set(type, module.name);
    this.mods.push(module);
    return this;
  }

  /** The names of the loaded modules, in load order. */
  loadout(): string[] {
    return this.mods.map((m) => m.name);
  }

  /** The full manifest — what each loaded module owns. */
  manifest(): ModuleManifest[] {
    return this.mods.map((m) => ({
      name: m.name,
      routes: Object.keys(m.httpRoutes ?? {}),
      messageTypes: Object.keys(m.messageHandlers ?? {}),
    }));
  }

  /** Wire every module once, in load order. Idempotent-guarded: a second call is a no-op after the first. */
  async init(ctx: Omit<ModuleContext, 'loadout' | 'manifest'>): Promise<void> {
    if (this.initialised) return;
    const full: ModuleContext = { ...ctx, loadout: () => this.loadout(), manifest: () => this.manifest() };
    for (const m of this.mods) await m.init?.(full);
    this.initialised = true;
  }

  /** Merged HTTP routes for `startControlServer`. Collision-free by construction (checked at `use()`). */
  routes(): Record<string, ControlHandler> {
    const out: Record<string, ControlHandler> = {};
    for (const m of this.mods) Object.assign(out, m.httpRoutes ?? {});
    return out;
  }

  /**
   * One `RequestHandler` that dispatches an inbound DIDComm message to the module owning its `type`, or
   * returns `null` (unhandled) so it composes with other readers. Collision-free by construction.
   */
  handler(): RequestHandler {
    const table = new Map<string, RequestHandler>();
    for (const m of this.mods) {
      for (const [type, h] of Object.entries(m.messageHandlers ?? {})) table.set(type, h);
    }
    return async (message: HearthholdMessage, fromDid: string) => {
      const h = table.get((message as { type?: string }).type ?? '');
      return h ? h(message, fromDid) : null;
    };
  }
}
