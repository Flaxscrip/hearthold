/**
 * Cross-node credential delivery over DIDComm.
 *
 * Deliver a verifiable credential from an issuer agent to a subject agent that may live on a **different
 * node with no shared registry**, and have the subject accept it (optionally KB-ingesting it). This is
 * deployment-agnostic: it works identically on a shared-registry node, where the import is simply a
 * harmless no-op because the VC is already resolvable.
 *
 * Why the content must travel in-band. `keymaster.acceptCredential(did)` resolves the VC to decrypt it.
 * Cross-node, Archon's DID resolution carries only the public W3C DID document — the encrypted
 * `didDocumentData` (the VC's actual content) is omitted by design, and the peer fallback fetches that
 * same stripped `/1.0/identifiers/{did}` (there IS a `/data` resource that carries it, but the fallback
 * does not use it — see docs/credential-delivery/FINDINGS.md). So the subject cannot pull + decrypt the
 * VC by reference; the issuer ships the immutable VC + schema ops and the subject imports them locally.
 *
 * The cache rule (offline-first correctness). We ship ONLY immutable, content-addressed assets — the VC
 * and its schema. We do NOT ship the issuer's Agent DID: identities are mutable (keys rotate, services
 * change), so a cached copy goes stale the moment the issuer updates while disconnected, and a stale
 * issuer silently breaks authcrypt (unpack failures are swallowed). The subject resolves the issuer
 * FRESH over the peer whenever it verifies or authcrypts. `opts.includeIssuerOps` is the only escape
 * hatch — a documented, refreshable THROWAWAY — needed today only because Archon core's `verifyOperation`
 * resolves the imported VC's controller with a local-only resolve; see the FINDINGS doc for the escalation.
 */

import type { KeymasterHandle } from './keymaster.js';
import type { Transport, RequestHandler } from './transport.js';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';
import {
  PROTOCOL_VERSION,
  type CredentialDeliveryMessage,
  type CredentialDeliveryAckMessage,
} from './protocol.js';

export interface DeliverCredentialOptions {
  /**
   * The schema DID the VC conforms to. By default it is read from the issuer's own view of the
   * credential; pass it explicitly for an issuer that does not retain a decryptable copy of what it issued.
   */
  schemaDid?: string;
  /**
   * Also ship the issuer's Agent DID ops — a REFRESHABLE THROWAWAY, never authoritative. Needed only when
   * the subject's gatekeeper cannot otherwise resolve the issuer to verify the imported VC (Archon core's
   * `verifyOperation` uses a local-only resolve). Default FALSE: ship only the immutable VC + schema and
   * let the subject resolve the issuer fresh over the peer. See docs/credential-delivery/FINDINGS.md.
   */
  includeIssuerOps?: boolean;
  /** Reply timeout for the delivery round-trip (default: the transport's own default). */
  timeoutMs?: number;
}

/**
 * Issuer side: package the VC (+ schema, + optional issuer throwaway) as immutable ops and deliver them
 * to `toDid` over DIDComm, awaiting the subject's accept/decline ack. authcrypt authenticates this issuer
 * as the sender at the transport layer, so no separate challenge is needed.
 */
export async function deliverCredential(
  issuer: KeymasterHandle,
  issuerName: string,
  transport: Transport,
  toDid: string,
  credentialDid: string,
  opts: DeliverCredentialOptions = {},
): Promise<CredentialDeliveryAckMessage> {
  const km = issuer.keymaster;

  // use-id guard. `setCurrentId` returns false for an unknown name instead of throwing (and the CLI even
  // exits 0), so a typo'd issuer would silently export/sign as whoever happens to be current. Fail loud.
  const ids = await km.listIds();
  if (!ids.includes(issuerName)) {
    throw new Error(
      `deliverCredential: unknown issuer identity '${issuerName}' (wallet has: ${ids.join(', ') || 'none'})`,
    );
  }
  await km.setCurrentId(issuerName);

  // Determine the schema DID — from the issuer's own view of the credential, or an explicit override.
  let schemaDid = opts.schemaDid;
  if (!schemaDid) {
    const vc = await km.getCredential(credentialDid).catch(() => null);
    schemaDid = vc?.credentialSchema?.id;
  }
  if (!schemaDid) {
    throw new Error(
      `deliverCredential: cannot determine schema DID for ${credentialDid} — pass opts.schemaDid`,
    );
  }

  // Export the IMMUTABLE ops in dependency order: schema before the VC that references it (issuer first
  // iff opted in). We export each DID singly and concatenate so the subject's import order is explicit and
  // never depends on the batch endpoint's internal ordering. `/dids/export` is public — no admin key.
  const gk = issuer.gatekeeper;
  const ops: GatekeeperEvent[][] = [];
  let includesIssuerThrowaway = false;

  if (opts.includeIssuerOps) {
    const info = await km.fetchIdInfo(issuerName);
    const issuerDid = info?.did;
    if (!issuerDid) throw new Error(`deliverCredential: cannot resolve issuer DID for '${issuerName}'`);
    const [issuerOps] = await gk.exportDIDs([issuerDid]);
    if (issuerOps?.length) {
      ops.push(issuerOps);
      includesIssuerThrowaway = true;
    }
  }

  const [schemaOps] = await gk.exportDIDs([schemaDid]);
  const [vcOps] = await gk.exportDIDs([credentialDid]);
  if (!schemaOps?.length || !vcOps?.length) {
    throw new Error('deliverCredential: gatekeeper returned no ops for the schema or the credential');
  }
  ops.push(schemaOps, vcOps);

  const message: CredentialDeliveryMessage = {
    type: 'hearthold/credential-delivery',
    version: PROTOCOL_VERSION,
    credentialDid,
    schemaDid,
    ops,
    includesIssuerThrowaway,
  };

  const reply = await transport.request(toDid, message, { timeoutMs: opts.timeoutMs });
  if (reply.type !== 'hearthold/credential-delivery-ack') {
    throw new Error(`deliverCredential: unexpected reply '${reply.type}' from ${toDid}`);
  }
  return reply;
}

/**
 * Optional VC→KB bridge, injected so `@hearthold/core` stays free of a `@hearthold/warden` dependency.
 * Called after a successful accept; returns the artefact id the credential was ingested to (or undefined
 * to skip ingest). Wire `ingestCredentialToPartition` here from the Warden side.
 */
export type OnCredentialAccepted = (
  subject: KeymasterHandle,
  credentialDid: string,
) => Promise<string | undefined>;

export interface CredentialDeliveryHandlerOptions {
  /**
   * Reopen a FRESH subject handle per request (e.g. `openKeymasterFresh`). Accepting a credential mutates
   * the wallet, so a long-lived daemon should reload-before-write to avoid clobbering a concurrent change;
   * omit it in in-process tests to keep using the static handle. Mirrors the Sovereign handler pattern.
   */
  reopen?: () => Promise<KeymasterHandle>;
  /** Optional VC→KB bridge run after accept (see OnCredentialAccepted). */
  onAccepted?: OnCredentialAccepted;
}

/**
 * Subject side: a `RequestHandler` that accepts `hearthold/credential-delivery` messages. It imports the
 * shipped immutable ops (making the VC locally resolvable), accepts the credential as `subjectName`, and
 * optionally runs the injected VC→KB bridge. Returns a `hearthold/credential-delivery-ack`. Returns null
 * for any other message type so it composes with other handlers.
 *
 * The issuer is NEVER cached here: even when `includesIssuerThrowaway` ships the issuer ops (to satisfy
 * the import-time controller resolve), any later verification/authcrypt resolves the issuer fresh over the
 * peer — the imported copy is a stopgap for one `importDIDs` call, not a trusted identity.
 */
export function makeCredentialDeliveryHandler(
  subject: KeymasterHandle,
  subjectName: string,
  opts: CredentialDeliveryHandlerOptions = {},
): RequestHandler {
  return async (message): Promise<CredentialDeliveryAckMessage | null> => {
    if (message.type !== 'hearthold/credential-delivery') return null;
    const m = message as CredentialDeliveryMessage;

    const handle = opts.reopen ? await opts.reopen() : subject;
    try {
      // Make the VC (+ schema, + throwaway issuer if shipped) locally resolvable, then confirm them.
      // Import is BEST-EFFORT so this stays deployment-agnostic: on a shared-registry node the VC is
      // already resolvable (the native short-circuit the DoD calls for), and `/dids/import` is often
      // admin-gated or not proxied there — so an import failure is fatal ONLY when the VC genuinely
      // does not resolve locally (the true cross-node case where the shipped ops were required).
      try {
        await handle.gatekeeper.importDIDs(m.ops);
        await handle.gatekeeper.processEvents();
      } catch (importErr) {
        const doc = await handle.keymaster.resolveDID(m.credentialDid).catch(() => null);
        if (!doc?.didDocument?.id) throw importErr;
      }

      // use-id guard on the subject too — never accept as the wrong (current) identity.
      const ids = await handle.keymaster.listIds();
      if (!ids.includes(subjectName)) {
        throw new Error(
          `unknown subject identity '${subjectName}' (wallet has: ${ids.join(', ') || 'none'})`,
        );
      }
      await handle.keymaster.setCurrentId(subjectName);

      const accepted = await handle.keymaster.acceptCredential(m.credentialDid);
      if (!accepted) {
        return {
          type: 'hearthold/credential-delivery-ack',
          version: PROTOCOL_VERSION,
          credentialDid: m.credentialDid,
          accepted: false,
          reason: 'acceptCredential returned false (VC not resolvable/decryptable for this subject)',
        };
      }

      let ingestedArtefactId: string | undefined;
      if (opts.onAccepted) {
        ingestedArtefactId = await opts.onAccepted(handle, m.credentialDid);
      }

      return {
        type: 'hearthold/credential-delivery-ack',
        version: PROTOCOL_VERSION,
        credentialDid: m.credentialDid,
        accepted: true,
        ingestedArtefactId,
      };
    } catch (err) {
      return {
        type: 'hearthold/credential-delivery-ack',
        version: PROTOCOL_VERSION,
        credentialDid: m.credentialDid,
        accepted: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
