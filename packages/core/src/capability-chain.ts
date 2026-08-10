/**
 * Capability issuance & verification — the I/O layer that mints a Sovereign ROOT capability and DELEGATES
 * attenuated children over Archon Asset DIDs, then verifies the chain. See docs/invocation.md (Phase 1).
 *
 * It composes `attenuation.ts` for the tamper-evident chain (lineage, counter, version-pinning, the signed
 * subset assertion, and the salted commitment — which now also binds our opaque `caveats` blob), and owns
 * the capability SEMANTICS here (via `capabilityNarrows` / `caveatsNarrow` from capability.ts). Attenuation
 * stays generic and never interprets caveats, so there is no layering cycle.
 *
 * Prior art (see docs/attributions.md): ZCAP-LD (root vs delegated, monotonic attenuation), Karp
 * (designation ≡ authority), Macaroons (caveats). The chain substrate is Hearthold's own attenuation.ts.
 */

import type { KeymasterHandle } from './keymaster.js';
import type { IssuedVc, AuthoritySetPayload, VerifyResult } from './attenuation.js';
import { issueVc, verifyAttenuationChain } from './attenuation.js';
import type { HearthholdCapability, Caveats } from './capability.js';
import { capabilityNarrows, caveatsNarrow, normalizeCaveats } from './capability.js';

/** A minted capability: the on-chain Asset-DID record plus the semantic capability whose `id` is that DID. */
export interface CapabilityHandle {
  issued: IssuedVc;
  capability: HearthholdCapability;
}

/** The parts a caller supplies for a capability; `id`/`controller`/`parentCapability` are filled by minting. */
export type CapabilitySpec = Pick<HearthholdCapability, 'invocationTarget' | 'authority' | 'caveats'>;

/**
 * Mint a ROOT capability (counter 0), controlled/signed by the issuer and held by `holder`. For the
 * Sovereign's own root over the vault, `issuerName` and `holder` are both the Sovereign.
 */
export async function mintRootCapability(args: {
  issuer: KeymasterHandle;
  /** Wallet-id NAME of the signing Agent DID (the delegator/root controller — e.g. the Sovereign). */
  issuerName: string;
  /** DID that holds (may invoke / further-delegate) this capability. */
  holder: string;
  capability: CapabilitySpec;
  registry: string;
}): Promise<CapabilityHandle> {
  const issued = await issueVc({
    issuer: args.issuer,
    issuerName: args.issuerName,
    holder: args.holder,
    authoritySet: args.capability.authority,
    caveats: normalizeCaveats(args.capability.caveats),
    registry: args.registry,
  });
  const capability: HearthholdCapability = {
    authorizationType: 'capability',
    id: issued.vcDid,
    controller: args.holder,
    invocationTarget: args.capability.invocationTarget,
    authority: args.capability.authority,
    caveats: args.capability.caveats,
  };
  return { issued, capability };
}

/**
 * Delegate an attenuated child of `parent` to `holder`. Refuses (throws) unless the child NARROWS the parent
 * across authority AND caveats — this is the issuance-time courtesy; the verifier is the real boundary.
 */
export async function delegateCapability(args: {
  issuer: KeymasterHandle;
  /** The delegator — must control the parent hop (e.g. the Sovereign delegating to the Emissary). */
  issuerName: string;
  parent: CapabilityHandle;
  /** The delegate/invoker that will hold the child (e.g. the Emissary). */
  holder: string;
  child: CapabilitySpec;
  registry: string;
}): Promise<CapabilityHandle> {
  // Only the HOLDER of the parent may delegate it onward — the issuance-time mirror of the verifier's delegator
  // binding (attenuation.ts, the sibling-hop forge guard). The issuer's DID must equal the parent's controller.
  const issuerDid = (await args.issuer.keymaster.resolveDID(args.issuerName)).didDocument?.id ?? '';
  if (issuerDid !== args.parent.capability.controller) {
    throw new Error('delegation refused: only the holder of the parent capability may delegate it onward');
  }
  const childCap: HearthholdCapability = {
    authorizationType: 'capability',
    id: 'urn:pending', // replaced with the minted Asset DID below
    controller: args.holder,
    parentCapability: args.parent.capability.id,
    invocationTarget: args.child.invocationTarget,
    authority: args.child.authority,
    caveats: args.child.caveats,
  };
  if (!capabilityNarrows(childCap, args.parent.capability)) {
    throw new Error('delegation refused: child capability does not attenuate its parent (authority or caveats widen)');
  }
  const issued = await issueVc({
    issuer: args.issuer,
    issuerName: args.issuerName,
    holder: args.holder,
    authoritySet: args.child.authority,
    caveats: normalizeCaveats(args.child.caveats),
    parent: args.parent.issued,
    registry: args.registry,
  });
  return { issued, capability: { ...childCap, id: issued.vcDid } };
}

/** Disclosure map for the verifier: each hop's revealed {authoritySet, salt, caveats}, keyed by Asset DID. */
export function discloseChain(...handles: CapabilityHandle[]): Record<string, AuthoritySetPayload> {
  return Object.fromEntries(
    handles.map((h) => [
      h.issued.vcDid,
      { authoritySet: h.issued.authoritySet, salt: h.issued.salt, caveats: h.issued.caveats },
    ]),
  );
}

/**
 * A capability held as a chain hop: this holder's own `handle` (its leaf — invocable AND further-delegable) plus
 * every ANCESTOR hop's disclosure (root → parent), so a presenter can disclose the whole chain to the verifier
 * without decrypting any private VC. Transferred pairwise between agents (`hearthold/chain-grant`). Empty
 * `ancestorDisclosures` ⇒ a root grant.
 */
export interface ChainCapabilityGrant {
  handle: CapabilityHandle;
  ancestorDisclosures: Record<string, AuthoritySetPayload>;
}

/** The full disclosure map to present when invoking a held grant: ancestors ∪ this leaf's own reveal. */
export function disclosedFor(grant: ChainCapabilityGrant): Record<string, AuthoritySetPayload> {
  return { ...grant.ancestorDisclosures, ...discloseChain(grant.handle) };
}

/** Pure: does every adjacent pair (ordered leaf→root) narrow its parent's caveats? */
export function caveatsChainNarrows(orderedLeafToRoot: Caveats[]): boolean {
  for (let i = 0; i < orderedLeafToRoot.length - 1; i++) {
    const child = orderedLeafToRoot[i];
    const parent = orderedLeafToRoot[i + 1];
    if (!child || !parent) return false;
    if (!caveatsNarrow(child, parent)) return false;
  }
  return true;
}

/**
 * Verify a capability chain from its leaf Asset DID. Runs `verifyAttenuationChain` (authority subset,
 * lineage, counter, version-pinning, signed assertions, and the caveat-committing binding), then — when the
 * ordered caveats are supplied (the reference monitor resolves them from the chain in Phase 2; e2e passes
 * them directly in Phase 1) — additionally enforces caveat NARROWING across the hops. Fail-closed.
 */
export async function verifyCapabilityChain(
  leafVcDid: string,
  opts: {
    keymaster: KeymasterHandle;
    expectedRootIssuer?: string;
    disclosed?: Record<string, AuthoritySetPayload>;
    maxHops?: number;
    /**
     * Require every hop disclosed and enforce caveat narrowing IN-CHAIN. Use this whenever the result will be
     * ENFORCED (the invocation monitor): it makes authority + caveats commitment-bound, so nothing is read
     * from an unauthenticated wire body. On success the result carries the bound leaf (`holder`,
     * `leafAuthoritySet`, `leafCaveats`) — enforce those, not `credentialSubject`.
     */
    requireFullDisclosure?: boolean;
    /** Revocation-by-default across the chain: a hop with no status pointer is refused (single-hop parity). */
    requireStatus?: boolean;
    /** Injected per-hop revocation check (the monitor resolves the StatusList). Fail-closed. See attenuation.ts. */
    checkHopStatus?: (caveats: unknown, hopController: string) => Promise<'ok' | 'revoked' | 'unavailable' | 'no-status'>;
  },
): Promise<VerifyResult> {
  return verifyAttenuationChain(leafVcDid, {
    keymaster: opts.keymaster,
    ...(opts.expectedRootIssuer !== undefined ? { expectedRootIssuer: opts.expectedRootIssuer } : {}),
    ...(opts.disclosed !== undefined ? { disclosed: opts.disclosed } : {}),
    ...(opts.maxHops !== undefined ? { maxHops: opts.maxHops } : {}),
    ...(opts.requireFullDisclosure ? { requireDisclosure: true } : {}),
    ...(opts.requireStatus ? { requireStatus: true } : {}),
    ...(opts.checkHopStatus ? { checkHopStatus: opts.checkHopStatus } : {}),
    // Attenuation stays generic; the capability layer injects its caveat semantics. Fail-closed on error.
    caveatNarrows: (child, parent) => {
      try {
        return caveatsNarrow(child as Caveats, parent as Caveats);
      } catch {
        return false;
      }
    },
  });
}
