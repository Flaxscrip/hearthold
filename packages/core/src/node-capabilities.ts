/**
 * Node capability discovery (@didcid 0.6.3 · `GET <nodeUrl>/api/v1/capabilities`).
 *
 * An Archon node advertises which features it offers as a flat map, e.g. `{ didcomm: true, lightning: true,
 * names: true }`. Hearthold uses this two ways:
 *   - a FAIL-FAST preflight on our own bound node (a node that can't route DIDComm is caught at startup with a
 *     clear message, not deep in the first serve — see `DidCommTransport.ready`);
 *   - the CROSS-NODE handshake — before opening a trust relationship with ANOTHER node (a shared Sphere /
 *     registry, or delivering a credential to a foreign DID), probe what that node actually supports.
 *
 * The check is deliberately PERMISSIVE and matches the keymaster's own `requireNodeCapability`: a capability
 * counts as supported UNLESS the node explicitly reports `false`. "Unknown" (node unreachable, or the key
 * absent) ⇒ permitted — so an older node with no capabilities endpoint is never broken by this. Only a node
 * that *says* it lacks a feature is refused.
 */

/** A node's advertised capabilities. Known keys typed for convenience; the map is open. */
export interface NodeCapabilities {
  /** DIDComm messaging — the whole agent transport depends on this. */
  didcomm?: boolean;
  /** Lightning payments. */
  lightning?: boolean;
  /** The name service. */
  names?: boolean;
  [capability: string]: boolean | undefined;
}

/**
 * Probe ANY Archon node's advertised capabilities. Returns the map, or `null` when the node is unreachable,
 * has no capabilities endpoint, or times out — a permissive "unknown". Timeout-bounded so a black-hole node
 * fails fast to `null` rather than stalling the caller. This is the cross-node handshake primitive: pass a
 * REMOTE node's URL to check its support before you rely on it.
 */
export async function discoverNodeCapabilities(
  nodeUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<NodeCapabilities | null> {
  const base = nodeUrl.replace(/\/+$/, '');
  if (!base) return null;
  // AbortController + setTimeout (not AbortSignal.timeout — missing in some WebView runtimes the stack targets);
  // clear the timer so it never keeps the event loop alive.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(`${base}/api/v1/capabilities`, { signal: controller.signal });
    return res.ok ? ((await res.json()) as NodeCapabilities) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Permissive support check (matches the keymaster): a capability is supported UNLESS the node explicitly
 * reports `false`. `null` caps (unknown) or an absent key ⇒ `true` — old nodes without the endpoint keep
 * working. Use this to DECIDE whether to attempt a feature.
 */
export function nodeSupports(caps: NodeCapabilities | null | undefined, capability: string): boolean {
  return caps?.[capability] !== false;
}

/**
 * The hard check: the node EXPLICITLY advertises it does NOT offer this capability. Use this to REFUSE
 * (fail-fast) — distinct from `!nodeSupports`, because "unknown" must not be treated as "lacks".
 */
export function nodeExplicitlyLacks(caps: NodeCapabilities | null | undefined, capability: string): boolean {
  return caps?.[capability] === false;
}
