/**
 * Trust registry — TRQP-shaped issuer/agent authorization.
 *
 * Adopts the ToIP **Trust Registry Query Protocol (TRQP) v2.0** shape used by `archon-trust-registry`
 * / `hatpro-archon` (POST `/authorization` with `{authority_id, entity_id, action, resource}` →
 * `{authorized, message}`), so a verifier trusts a **registry** instead of a hardcoded issuer list.
 *
 * Two implementations behind one `TrustEvaluator` seam:
 *   - `HttpTrustRegistry` — consume a remote TRQP registry (the ecosystem/guild registry, outward).
 *   - `GroupTrustRegistry` — run a registry in-process over **Archon groups** (the Sovereign's own
 *     registry of its Witnesses, inward). Membership in the group bound to `(action, resource)` *is*
 *     the authorization — exactly archon-trust-registry's "groups are the authorization store", but
 *     bound per-resource (not just per-role) so we can grade autonomy by what's being done.
 *
 * The same primitive runs both ways: outward `(issuer, issue, schema)` = "may this issuer issue this
 * credential type?"; inward `(witnessDid, present, sensitivity)` = "is this Witness cleared to present
 * at this level, or must it relay to the Signet?" See docs/trust-graph-and-delegation.md §6.
 */

import type { KeymasterHandle } from './keymaster.js';

/** TRQP standard actions. `issue` is the outward case; `present` carries the inward Witness case. */
export type TrqpAction = 'issue' | 'verify' | 'hold' | 'present' | 'revoke';

/** A TRQP authorization query. */
export interface AuthorizationQuery {
  /** The DID being evaluated — an issuer (outward) or a Witness W-DID (inward). */
  entity_id: string;
  /** The verb. */
  action: TrqpAction | string;
  /** The thing acted on — a schema DID (outward) or a sensitivity level (inward). Optional. */
  resource?: string;
  /** The governing registry DID; defaults to the evaluator's own authority. */
  authority_id?: string;
  /** Free context (e.g. `{ time }`). */
  context?: Record<string, unknown>;
}

/** A TRQP authorization result (the fields archon-trust-registry returns). */
export interface AuthorizationResult {
  authorized: boolean;
  message: string;
  entity_id?: string;
  authority_id?: string;
  action?: string;
  resource?: string | null;
}

/** Anything that can answer "is this entity authorized for this action (on this resource)?" */
export interface TrustEvaluator {
  authorize(query: AuthorizationQuery): Promise<AuthorizationResult>;
}

const short = (did: string): string => (did.length > 28 ? `${did.slice(0, 28)}…` : did);

/**
 * Consume a remote TRQP v2.0 registry over HTTP. Wire-compatible with `archon-trust-registry`
 * (the registry `hatpro-archon` runs on :4260). Fail-closed: any error → not authorized.
 */
export class HttpTrustRegistry implements TrustEvaluator {
  constructor(
    /** Registry base URL, e.g. http://localhost:4260 */
    private readonly url: string,
    /** This registry's authority DID (`authority_id`). */
    private readonly authorityId: string,
  ) {}

  async authorize(query: AuthorizationQuery): Promise<AuthorizationResult> {
    try {
      const res = await fetch(`${this.url}/authorization`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          authority_id: query.authority_id ?? this.authorityId,
          entity_id: query.entity_id,
          action: query.action,
          resource: query.resource,
          context: query.context,
        }),
      });
      if (!res.ok) return { authorized: false, message: `trust-registry ${res.status}` };
      const j = (await res.json()) as Partial<AuthorizationResult> & { authorized?: boolean };
      return {
        authorized: !!j.authorized,
        message: String(j.message ?? ''),
        entity_id: query.entity_id,
        authority_id: query.authority_id ?? this.authorityId,
        action: String(query.action),
        resource: query.resource ?? null,
      };
    } catch (e) {
      return { authorized: false, message: `trust-registry unreachable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

/** Binds an `(action, resource)` to an Archon group whose membership grants that authorization. */
export interface GroupBinding {
  action: TrqpAction | string;
  /** Omit for a wildcard binding that covers any resource for this action. */
  resource?: string;
  /** The Archon group DID; membership = authorized. */
  group: string;
}

/**
 * Run a TRQP registry in-process over Archon groups. Authorization = membership (via
 * `keymaster.testGroup`, which resolves nested groups) in the group bound to `(action, resource)`,
 * preferring an exact-resource binding over a wildcard. Any DID can evaluate (testGroup resolves the
 * group from the gatekeeper); only the group owner can grant/revoke (see `grantAuthorization`).
 */
export class GroupTrustRegistry implements TrustEvaluator {
  constructor(
    private readonly handle: KeymasterHandle,
    private readonly bindings: GroupBinding[],
    /** This registry's authority DID, for the result envelope. */
    private readonly authorityId?: string,
  ) {}

  async authorize(query: AuthorizationQuery): Promise<AuthorizationResult> {
    const exact = this.bindings.find((b) => b.action === query.action && b.resource === query.resource);
    const wildcard = this.bindings.find((b) => b.action === query.action && b.resource === undefined);
    const binding = exact ?? wildcard;

    const envelope = {
      entity_id: query.entity_id,
      authority_id: query.authority_id ?? this.authorityId,
      action: String(query.action),
      resource: query.resource ?? null,
    };
    const target = `${query.action}${query.resource ? `+${query.resource}` : ''}`;

    if (!binding) {
      return { ...envelope, authorized: false, message: `no authorization rule for ${target}` };
    }
    const ok = await this.handle.keymaster.testGroup(binding.group, query.entity_id).catch(() => false);
    return {
      ...envelope,
      authorized: ok,
      message: ok
        ? `${short(query.entity_id)} is authorized for ${target}`
        : `${short(query.entity_id)} is not authorized for ${target}`,
    };
  }
}

// ── Provisioning (the registry owner's side) ──────────────────────────────────

/** Create an Archon group to hold the entities authorized for some `(action, resource)`. */
export async function createRegistryGroup(
  owner: KeymasterHandle,
  name: string,
  registry: string,
): Promise<string> {
  return owner.keymaster.createGroup(name, { registry });
}

/** Grant authorization: add `entityDid` to the group. Owner-only. */
export async function grantAuthorization(
  owner: KeymasterHandle,
  groupDid: string,
  entityDid: string,
): Promise<boolean> {
  return owner.keymaster.addGroupMember(groupDid, entityDid);
}

/** Revoke authorization: remove `entityDid` from the group (e.g. a Witness whose condition dropped). */
export async function revokeAuthorization(
  owner: KeymasterHandle,
  groupDid: string,
  entityDid: string,
): Promise<boolean> {
  return owner.keymaster.removeGroupMember(groupDid, entityDid);
}
