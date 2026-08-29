/**
 * OPTIONAL public-resolver fallback for DID RESOLUTION only — the identity/data split.
 *
 * A Warden bound to a sealed/private node can list an external member's DID in a trust group but cannot
 * *resolve* that member's DID document (its identity lives on a registry the sealed node has no peer for) —
 * so it can authorize but not authenticate. This wrapper lets a Sovereign OPT IN to a public resolver used
 * strictly to read a DID document the bound node can't. A public DID document is not secret; vault data
 * never touches this path. Default (no fallback) = the primary unchanged = full isolation preserved.
 *
 * Pure, zero-import — so it is unit-testable in isolation and can't drag the Keymaster/Gatekeeper/config
 * chain into a hermetic test. `keymaster.ts` re-exports these and does the live GatekeeperClient wiring.
 */

/** The minimal resolve surface both the primary and fallback gatekeepers share. */
export interface DidResolver {
  resolveDID(did?: string, options?: { verify?: boolean } & Record<string, unknown>): Promise<unknown>;
}

/** A resolved DID document carries `didDocument.id`; a not-found result carries no id (and an error tag). */
export function resolvedId(doc: unknown): string | undefined {
  const id = (doc as { didDocument?: { id?: unknown } } | undefined)?.didDocument?.id;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * Wrap a primary (private-node) resolver so a DID it can't resolve falls back to a public resolver — for
 * IDENTITY resolution ONLY (reading a public DID document), never data. Local-first: the fallback is consulted
 * only when the primary returns not-found or errors. The fallback resolves with `{verify:true}` (the gatekeeper
 * client validates the returned document) AND we re-check the returned `didDocument.id` equals the requested
 * DID — so a fallback resolver cannot substitute a different identity's document. With no `fallback`, this is
 * the primary unchanged (full isolation). Only `resolveDID` is altered; every other gatekeeper method is the
 * primary's, so anchoring/export/processEvents stay on the bound node.
 */
export function withResolverFallback<G extends DidResolver>(primary: G, fallback: DidResolver | undefined): G {
  if (!fallback) return primary;
  return new Proxy(primary, {
    get(target, prop, receiver) {
      if (prop !== 'resolveDID') return Reflect.get(target, prop, receiver);
      return async (did?: string, options?: { verify?: boolean } & Record<string, unknown>) => {
        try {
          const doc = await target.resolveDID(did, options);
          if (resolvedId(doc)) return doc; // the bound node has it — never leave for a DID we can resolve
        } catch {
          /* primary couldn't resolve — fall through to the public resolver */
        }
        // Public resolver, VERIFIED. `verify:true` makes the gatekeeper validate the document; the id-match
        // check below prevents substitution. Identity in, no data out.
        const doc = await fallback.resolveDID(did, { ...(options ?? {}), verify: true });
        const gotId = resolvedId(doc);
        if (did && gotId && gotId !== did) {
          throw new Error(`resolver fallback: returned document id ${gotId} ≠ requested DID ${did} (refusing a substituted identity)`);
        }
        return doc;
      };
    },
  }) as G;
}
