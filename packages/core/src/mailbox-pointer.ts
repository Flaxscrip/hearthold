/**
 * Q2 — identity → mailbox resolution via a published DID-document service pointer.
 *
 * The family roster carries STABLE identity (Sovereign) DIDs, but messaging must reach a served MAILBOX
 * (the agent's Warden). This bridges them: the identity publishes a `HearthholdMailbox` service entry on its
 * OWN DID document, pointing at its current mailbox DID. A correspondent resolves identity → current mailbox
 * through it — so a mailbox rotation (a fresh Warden DID) is a NON-EVENT: the identity re-points its own
 * service and everyone picks up the new mailbox on the next resolve, with no roster re-sign.
 *
 * Security: the pointer lives on the identity's DID document, which ONLY the identity's controller can update
 * (`updateDID` is signed by the DID's controller). So the pointer is self-asserted — forging it would require
 * already controlling the identity, which is game-over regardless. Resolution introduces no new trust surface.
 */
import { currentIdentity } from './identity.js';
import type { KeymasterHandle } from './keymaster.js';

/** The DID-document `service` type that points an identity at its current Hearthold mailbox (Warden) DID. */
export const MAILBOX_SERVICE_TYPE = 'HearthholdMailbox';

interface ServiceEntry {
  id?: string;
  type: string;
  serviceEndpoint: unknown;
}

/**
 * Publish (or re-point) the current identity's mailbox pointer: add a `HearthholdMailbox` service to this
 * identity's DID document whose endpoint is `mailboxDid`. Runs as the identity's controller (the handle's
 * current id). Returns the identity DID the pointer was written to.
 */
export async function publishMailboxPointer(handle: KeymasterHandle, mailboxDid: string): Promise<string> {
  if (!mailboxDid.startsWith('did:')) throw new Error('mailboxDid must be a did:cid');
  const me = await currentIdentity(handle);
  if (!me) throw new Error('no current identity to publish a mailbox pointer for');
  const resolved = await handle.keymaster.resolveDID(me.did);
  const didDocument = { ...(resolved.didDocument as { service?: ServiceEntry[] } & Record<string, unknown>) };
  const service = (didDocument.service ?? []).filter((s) => s.type !== MAILBOX_SERVICE_TYPE);
  service.push({ id: `${me.did}#hearthold-mailbox`, type: MAILBOX_SERVICE_TYPE, serviceEndpoint: mailboxDid });
  didDocument.service = service;
  await handle.keymaster.updateDID(me.did, didDocument as never);
  return me.did;
}

/**
 * Resolve an identity DID to its current mailbox DID via the published pointer. Returns undefined when the
 * identity publishes no `HearthholdMailbox` pointer (the caller should then fall back to addressing the DID
 * itself — it may already BE a served mailbox).
 */
export async function resolveMailboxPointer(handle: KeymasterHandle, identityDid: string): Promise<string | undefined> {
  const resolved = await handle.keymaster.resolveDID(identityDid).catch(() => null);
  const service = (resolved?.didDocument as { service?: ServiceEntry[] } | undefined)?.service ?? [];
  const entry = service.find((s) => s.type === MAILBOX_SERVICE_TYPE);
  const endpoint = entry?.serviceEndpoint;
  return typeof endpoint === 'string' && endpoint.startsWith('did:') ? endpoint : undefined;
}
