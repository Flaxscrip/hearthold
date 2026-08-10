/**
 * The Emissary's MULTI-HOP delegation gestures — hand a *narrower slice* of a held capability onward to another
 * agent, and later present a held chain to invoke evidence. This is the family primitive: agents pass attenuated
 * authority hop-to-hop, each hop revocable by whoever issued it (see docs/multihop-delegation.md).
 *
 * A held chain-capability is `{ handle, ancestorDisclosures }`: the `CapabilityHandle` this Emissary holds (its
 * leaf hop — invocable AND further-delegable) plus every ANCESTOR hop's revealed `{authoritySet, salt, caveats}`
 * so a presenter can disclose the whole chain to the verifier without decrypting anyone's private VC. Enforcement
 * lives in the Warden's monitor (`resolveChainInvocation`); these are the holder-side gestures that feed it.
 */

import { randomUUID } from 'node:crypto';

import {
  delegateCapability,
  discloseChain,
  ensureCapabilityStatusContext,
  allocateIndex,
  STATUS_LIST_LENGTH,
  PROTOCOL_VERSION,
  type KeymasterHandle,
  type Transport,
  type HearthholdConfig,
  type CapabilityHandle,
  type CapabilitySpec,
  type AuthoritySetPayload,
  type CapabilityInvocation,
  type SignedHolderProof,
  type EvidenceResponse,
  type ErrorMessage,
  type ChallengeResponseMessage,
} from '@hearthold/core';

/** A capability this Emissary HOLDS as a chain hop: its own handle + every ancestor hop's disclosure. */
export interface ChainCapabilityGrant {
  /** This hop's handle — invocable, and usable as the parent for a further `delegateOnward`. */
  handle: CapabilityHandle;
  /** Ancestor hops' revealed `{authoritySet, salt, caveats}` (root → parent), keyed by Asset DID. The holder
   *  adds its own leaf reveal at present time (`disclosedFor`). Empty for a root grant. */
  ancestorDisclosures: Record<string, AuthoritySetPayload>;
}

/** A hop this Emissary ISSUED to a delegate — kept so the issuer can revoke it (its own kill-switch over its child). */
export interface IssuedHop {
  childVcDid: string;
  holder: string;
  statusListCredential: string;
  statusListIndex: number;
  issuedAt: string;
}

/** The full disclosure map to present when invoking a held grant: ancestors ∪ this leaf's own reveal. */
export function disclosedFor(grant: ChainCapabilityGrant): Record<string, AuthoritySetPayload> {
  return { ...grant.ancestorDisclosures, ...discloseChain(grant.handle) };
}

/**
 * Delegate an attenuated child of a HELD grant onward to `holderDid`, minted with a fresh revocation status from
 * THIS issuer's status list — so the child is revocable and the issuer holds the bit (revoking it kills the
 * delegate's subtree at the next invocation). Returns the transfer package to hand the delegate (pairwise) plus
 * the issued-hop record to keep for revocation. `delegateCapability` refuses a non-attenuating child at issuance;
 * the Warden's verifier is the real boundary.
 */
export async function delegateOnward(args: {
  issuer: KeymasterHandle;
  issuerName: string;
  config: HearthholdConfig;
  /** The capability this Emissary holds (root or an inner hop) that it is attenuating. */
  parent: ChainCapabilityGrant;
  holderDid: string;
  /** The narrower child (authority ⊆ parent, caveats ≤ parent). A status pointer is added here automatically. */
  child: CapabilitySpec;
}): Promise<{ grant: ChainCapabilityGrant; issued: IssuedHop }> {
  // Allocate a revocation index from THIS issuer's status list; bound into the child's caveats commitment.
  const statusCtx = await ensureCapabilityStatusContext(args.issuer, args.issuerName, args.config);
  const { index } = await allocateIndex(args.issuer, args.issuerName, statusCtx.allocationRecord, randomUUID(), STATUS_LIST_LENGTH);
  const childSpec: CapabilitySpec = {
    ...args.child,
    caveats: { ...args.child.caveats, status: { statusListCredential: statusCtx.statusListCredential, statusListIndex: index } },
  };
  const childHandle = await delegateCapability({
    issuer: args.issuer,
    issuerName: args.issuerName,
    parent: args.parent.handle,
    holder: args.holderDid,
    child: childSpec,
    registry: args.config.registry,
  });
  // The delegate's ancestor set = our ancestors ∪ our own (now-parent) hop's reveal.
  const grant: ChainCapabilityGrant = {
    handle: childHandle,
    ancestorDisclosures: { ...args.parent.ancestorDisclosures, ...discloseChain(args.parent.handle) },
  };
  const issued: IssuedHop = {
    childVcDid: childHandle.issued.vcDid,
    holder: args.holderDid,
    statusListCredential: statusCtx.statusListCredential,
    statusListIndex: index,
    issuedAt: new Date().toISOString(),
  };
  return { grant, issued };
}

/**
 * Present a HELD chain to the Warden and request evidence. The chain analog of `invokeEvidence`: fetch a fresh
 * Warden-minted invocation challenge, sign a holder proof over it (proving control of this hop's holder DID),
 * disclose the whole chain, and send the invocation. The Warden's `resolveChainInvocation` verifies the chain +
 * per-hop revocation, binds the caller to the chain-attested holder, and authorizes the act. Returns its reply.
 */
export async function chainInvokeEvidence(
  handle: KeymasterHandle,
  holderName: string,
  transport: Pick<Transport, 'request'>,
  wardenDid: string,
  grant: ChainCapabilityGrant,
  spec: { claim: string; kind: string; target?: string; reveal?: number[] },
): Promise<EvidenceResponse | ErrorMessage> {
  const leafVcDid = grant.handle.issued.vcDid;
  const target = spec.target ?? `hearthold:vault:${spec.kind}`;

  const chReply = await transport.request(wardenDid, {
    type: 'hearthold/challenge-request',
    version: PROTOCOL_VERSION,
    purpose: 'invocation',
  });
  if (chReply.type !== 'hearthold/challenge-response') {
    const reason = chReply.type === 'hearthold/error' ? (chReply as ErrorMessage).reason : `unexpected reply ${chReply.type}`;
    return { type: 'hearthold/error', version: PROTOCOL_VERSION, reason: `could not obtain an invocation challenge: ${reason}` };
  }
  const challenge = (chReply as ChallengeResponseMessage).challenge;
  const txn = randomUUID();

  // Prove control of THIS hop's holder DID by signing over the fresh challenge (freshness + holder binding).
  await handle.keymaster.setCurrentId(holderName);
  const holderProof = (await handle.keymaster.addProof(
    { type: 'hearthold/chain-holder-proof', challenge, leafVcDid, txn },
    holderName,
  )) as unknown as SignedHolderProof;

  const inv: CapabilityInvocation = {
    type: 'hearthold/invocation',
    version: PROTOCOL_VERSION,
    chain: { leafVcDid, disclosed: disclosedFor(grant), holderProof },
    act: {
      action: 'prove',
      target,
      nonce: randomUUID(),
      txn,
      args: { claim: spec.claim, spec: { kind: spec.kind }, ...(spec.reveal && spec.reveal.length > 0 ? { reveal: spec.reveal } : {}) },
    },
  };
  const reply = await transport.request(wardenDid, inv);
  if (reply.type === 'hearthold/evidence-response') return reply as EvidenceResponse;
  if (reply.type === 'hearthold/error') return reply as ErrorMessage;
  return { type: 'hearthold/error', version: PROTOCOL_VERSION, reason: `unexpected reply ${reply.type}` };
}
