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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  delegateCapability,
  disclosedFor,
  ensureCapabilityStatusContext,
  allocateIndex,
  STATUS_LIST_LENGTH,
  PROTOCOL_VERSION,
  type KeymasterHandle,
  type Transport,
  type HearthholdConfig,
  type CapabilitySpec,
  type ChainCapabilityGrant,
  type ChainGrantMessage,
  type CapabilityInvocation,
  type SignedHolderProof,
  type EvidenceResponse,
  type ErrorMessage,
  type ChallengeResponseMessage,
} from '@hearthold/core';

export type { ChainCapabilityGrant } from '@hearthold/core';
export { disclosedFor } from '@hearthold/core';

/** A hop this Emissary ISSUED to a delegate — kept so the issuer can revoke it (its own kill-switch over its child). */
export interface IssuedHop {
  childVcDid: string;
  holder: string;
  statusListCredential: string;
  statusListIndex: number;
  issuedAt: string;
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
  // The delegate's ancestor set = our ancestors ∪ our own (now-parent) hop's reveal = disclosedFor(parent).
  const grant: ChainCapabilityGrant = {
    handle: childHandle,
    ancestorDisclosures: disclosedFor(args.parent),
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

/**
 * Hand a chain grant to its recipient over DIDComm (fire-and-forget — authcrypt authenticates the sender; the
 * recipient's daemon persists it in its `HeldChainStore`). Used by a Sovereign to seed a ROOT grant to an
 * Emissary, and by a delegator to transfer a delegated child hop to its delegate.
 */
export async function transferChainGrant(
  handle: KeymasterHandle,
  senderName: string,
  toDid: string,
  grant: ChainCapabilityGrant,
): Promise<void> {
  const msg: ChainGrantMessage = { type: 'hearthold/chain-grant', version: PROTOCOL_VERSION, grant };
  await handle.keymaster.sendDidComm({ type: msg.type, thid: randomUUID(), body: msg }, toDid, { name: senderName });
}

/**
 * File-backed store of the chain-capabilities this Emissary HOLDS (grants it received) and the hops it has
 * ISSUED to delegates (kept so it can revoke them). Lives beside the wallet in the agent's data folder. Keyed by
 * leaf Asset DID; most-recent grant wins for the "invoke my capability" convenience (`latest`).
 */
export class HeldChainStore {
  private readonly grantsFile: string;
  private readonly issuedFile: string;
  constructor(private readonly dataFolder: string) {
    this.grantsFile = join(dataFolder, 'held-chains.json');
    this.issuedFile = join(dataFolder, 'issued-hops.json');
  }
  private async readGrants(): Promise<ChainCapabilityGrant[]> {
    try {
      return JSON.parse(await readFile(this.grantsFile, 'utf8')) as ChainCapabilityGrant[];
    } catch {
      return [];
    }
  }
  async put(grant: ChainCapabilityGrant): Promise<void> {
    await mkdir(this.dataFolder, { recursive: true });
    const all = (await this.readGrants()).filter((g) => g.handle.issued.vcDid !== grant.handle.issued.vcDid);
    all.push(grant);
    await writeFile(this.grantsFile, JSON.stringify(all, null, 2), 'utf8');
  }
  async list(): Promise<ChainCapabilityGrant[]> {
    return this.readGrants();
  }
  async get(leafVcDid: string): Promise<ChainCapabilityGrant | undefined> {
    return (await this.readGrants()).find((g) => g.handle.issued.vcDid === leafVcDid);
  }
  /** The most recently received grant — the default for a "prove with my capability" invoke. */
  async latest(): Promise<ChainCapabilityGrant | undefined> {
    const all = await this.readGrants();
    return all[all.length - 1];
  }

  private async readIssued(): Promise<IssuedHop[]> {
    try {
      return JSON.parse(await readFile(this.issuedFile, 'utf8')) as IssuedHop[];
    } catch {
      return [];
    }
  }
  async putIssued(hop: IssuedHop): Promise<void> {
    await mkdir(this.dataFolder, { recursive: true });
    const all = (await this.readIssued()).filter((h) => h.childVcDid !== hop.childVcDid);
    all.push(hop);
    await writeFile(this.issuedFile, JSON.stringify(all, null, 2), 'utf8');
  }
  async listIssued(): Promise<IssuedHop[]> {
    return this.readIssued();
  }
  async getIssued(childVcDid: string): Promise<IssuedHop | undefined> {
    return (await this.readIssued()).find((h) => h.childVcDid === childVcDid);
  }
}
