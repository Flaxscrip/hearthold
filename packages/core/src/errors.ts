/**
 * Render ANY thrown value as a human-readable string.
 *
 * `String(err)` on a non-Error object yields the useless `"[object Object]"` — the exact line that hid a
 * `registry local not supported` rejection for a full day (the gatekeeper/HTTP client rejected with a bare
 * object, not an `Error`, and the top-level sink `String()`-ed it). Prefer a message-like field, else JSON,
 * so a non-Error thrown anywhere becomes legible at the sink even when the throw site can't be fixed.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    for (const k of ['message', 'error', 'reason'] as const) {
      const v = o[k];
      if (typeof v === 'string' && v) return v;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err); // circular / non-serialisable — better than throwing from an error handler
    }
  }
  return String(err);
}
