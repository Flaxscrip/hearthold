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
import type { DmzSession } from './dmz.js';
import { buildIssuedLeaf, type IssuedLeaf, type ResolvedCredential } from './issued.js';
import { decideRelease, type ReleaseContext } from './security.js';
import {
  PROTOCOL_VERSION,
  type CredentialDeliveryMessage,
  type CredentialDeliveryAckMessage,
} from './protocol.js';

/** The outcome of verifying a foreign credential in the DMZ: the verified closure, or a fail-closed reason. */
export interface ForeignVerification {
  ok: boolean;
  /** The verified `issued` leaf — the ONLY thing kept from the DMZ (never the raw ops). Present iff `ok`. */
  leaf?: IssuedLeaf;
  /**
   * Whether the credential's PAYLOAD (claims) was decryptable in the DMZ. False for the common cross-node
   * case — a VC's content is encrypted to the SENDER's audience, which a peerless DMZ (and the recipient)
   * has no key for. `false` ⇒ the closure is provenance-only (chain-verified issuer/type, no claims); the
   * card is still acceptable (the DMZ's job is trust, not plaintext). `true` ⇒ full claims (subject/public).
   */
  contentReadable?: boolean;
  /** The exact verified version the chain resolved to in the DMZ (provenance pin). */
  versionId?: string;
  reason?: string;
}

/**
 * Verify a cross-node credential inside an ephemeral, PEERLESS DMZ and return ONLY the verified closure —
 * never importing the foreign ops into the caller's own gatekeeper (that is a compile error anyway, B6). It
 * imports the shipped ops into the DMZ and verifies the credential's chain there — the CHAIN is the trust
 * gate. It then reads the payload BEST-EFFORT: a VC encrypted to the SENDER's audience (the common cross-node
 * case) can't be decrypted by this peerless DMZ, so we keep a PROVENANCE closure (chain-verified issuer/type
 * from the public DID document, no claims) rather than declining an otherwise-valid card — the DMZ's job is
 * trust, not plaintext. ALWAYS tears the DMZ down in `finally`. Fail closed ONLY on a real failure (no DMZ,
 * no ops, chain invalid, DMZ error) → `{ ok:false, reason }`, nothing kept. The caller keeps `leaf` (the
 * closure), discards the ops, and promotes it on accept; `contentReadable` says whether claims are present.
 */
export async function verifyForeignCredential(
  openDmz: () => Promise<DmzSession>,
  m: CredentialDeliveryMessage,
): Promise<ForeignVerification> {
  let session: DmzSession | undefined;
  try {
    session = await openDmz();
    await session.import(m.ops, [m.schemaDid, m.credentialDid]);
    const chain = await session.verifyChain(m.credentialDid);
    if (!chain.ok) return { ok: false, reason: `DMZ chain verification failed: ${chain.reason ?? 'chain did not verify'}` };
    // Chain verified — the trust gate is passed. Try to read the plaintext; keep a provenance closure if not.
    const vc = await session.keymaster.getCredential(m.credentialDid).catch(() => null);
    if (vc) {
      return { ok: true, leaf: buildIssuedLeaf(m.credentialDid, vc as ResolvedCredential), versionId: chain.versionId, contentReadable: true };
    }
    // Provenance-only: the issuer is the credential's controller (public in the DID document — no decrypt).
    const doc = await session.keymaster.resolveDID(m.credentialDid).catch(() => null);
    const issuer = (doc?.didDocument as { controller?: string } | undefined)?.controller ?? '';
    const leaf: IssuedLeaf = {
      trustClass: 'issued',
      credentialDid: m.credentialDid,
      issuer,
      subject: '',
      credentialType: 'VerifiableCredential',
      schema: m.schemaDid,
      claims: {},
      descriptionSource: 'issuer-asserted',
      status: 'valid',
      acceptedAt: new Date().toISOString(),
    };
    return { ok: true, leaf, versionId: chain.versionId, contentReadable: false };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.teardown(); // ephemeral: nothing survives on our node, on every path
  }
}

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
  /**
   * A recipient-readable rendering of the VC's claims, already sealed to `toDid` by the caller (the sender,
   * who can read the VC). Shipped in the delivery message beside the immutable ops so a readable pass hands
   * over decryptable content. See `CredentialDeliveryMessage.recipientSealed`.
   */
  recipientSealed?: string;
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
    ...(opts.recipientSealed ? { recipientSealed: opts.recipientSealed } : {}),
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
  /** Optional VC→KB bridge run after a native accept (see OnCredentialAccepted). */
  onAccepted?: OnCredentialAccepted;
  /**
   * Open an ephemeral, peerless DMZ session for the CROSS-NODE case (the VC is not resolvable on the
   * subject's own gatekeeper). The handler imports + verifies there and NEVER imports foreign ops into the
   * node's own gatekeeper (B6 GATEKEEPER PURITY — now impossible by type). Omit it and an unresolvable VC
   * fails closed rather than polluting the private gatekeeper. See `dmz.ts`.
   */
  openDmz?: () => Promise<DmzSession>;
  /** Optional keep-closure hook run after a successful DMZ verification (returns a kept-closure id). */
  onVerified?: (session: DmzSession, credentialDid: string, message: CredentialDeliveryMessage) => Promise<string | undefined>;
}

/**
 * Subject side: a `RequestHandler` for `hearthold/credential-delivery`. Two paths, and NEITHER imports
 * foreign ops into the node's own gatekeeper (B6):
 *   - the VC already resolves here (shared-registry / native): accept it natively as `subjectName`;
 *   - it does not (cross-node): verify it in an ephemeral, peerless DMZ (`openDmz`) and keep only the
 *     minimal closure — the node's own gatekeeper is never touched. Without a DMZ, this fails closed.
 * Returns a `hearthold/credential-delivery-ack`; returns null for other message types so it composes.
 *
 * The issuer is NEVER cached: even when `includesIssuerThrowaway` ships the issuer ops (to satisfy the
 * DMZ's import-time controller resolve), later verification resolves the issuer fresh — the imported copy
 * lives and dies inside the DMZ, never in the node's own gatekeeper.
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
      // Is the VC already resolvable on our OWN gatekeeper? (shared-registry / native short-circuit)
      const resolvable = await handle.keymaster
        .resolveDID(m.credentialDid)
        .then((d) => Boolean(d.didDocument?.id))
        .catch(() => false);

      if (!resolvable) {
        // CROSS-NODE: the ops are foreign. We must NOT import them into our own gatekeeper (B6 — now a
        // type error anyway). Verify in an ephemeral, peerless DMZ and keep only the closure; fail closed
        // if no DMZ is wired (refusing to pollute the private gatekeeper is the correct, safe outcome).
        if (!opts.openDmz) {
          return {
            type: 'hearthold/credential-delivery-ack',
            version: PROTOCOL_VERSION,
            credentialDid: m.credentialDid,
            accepted: false,
            reason: 'VC not resolvable on this node and no DMZ configured — refusing to import foreign ops into the private gatekeeper (fail closed)',
          };
        }
        const session = await opts.openDmz();
        try {
          await session.import(m.ops, [m.schemaDid, m.credentialDid]);
          const chain = await session.verifyChain(m.credentialDid);
          if (!chain.ok) {
            return {
              type: 'hearthold/credential-delivery-ack',
              version: PROTOCOL_VERSION,
              credentialDid: m.credentialDid,
              accepted: false,
              reason: `DMZ verification failed: ${chain.reason ?? 'chain did not verify'}`,
            };
          }
          const keptId = opts.onVerified ? await opts.onVerified(session, m.credentialDid, m) : undefined;
          return {
            type: 'hearthold/credential-delivery-ack',
            version: PROTOCOL_VERSION,
            credentialDid: m.credentialDid,
            accepted: true,
            ingestedArtefactId: keptId,
          };
        } finally {
          session.teardown(); // ephemeral: the DMZ instance is torn down; nothing survives on our node
        }
      }

      // NATIVE path — the VC is already resolvable here; accept it into the wallet, no import needed.
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

// ── Foreign-verifier path (issue-credential 3.0 · @didcid 0.6.3) ──────────────────────────────────────────
//
// The card-pass path above ships raw ops for an ARCHON holder to import + accept into a wallet. This path is
// for a subject OUTSIDE Archon. It carries the SIGNED CREDENTIAL ITSELF as an issue-credential/3.0 attachment
// (`keymaster.sendCredentialDidComm`), and the recipient trusts it by resolving the ISSUER's `did:cid` and
// checking the proof — no wallet, no op-import, no shared registry. This is the Blazon *publish* transport
// (`docs/blazon-didcomm-disclosure.md`): the interop route for Hearthold-issued evidence to reach a
// non-Archon verifier. `sendCredentialDidComm` is publish, NOT a replacement for the interactive *prove*
// path (challenge/response), which stays ours.

export interface ForeignDisclosureArgs {
  /** The DIDComm recipient — the foreign agent's inbox DID (what the issue-credential message is sent `to`). */
  toDid: string;
  /**
   * The subject the fact is ABOUT (`credentialSubject.id`): the foreign agent's own identifier (a
   * `did:web` / `did:key` / …), a pairwise DID, or a public Blazon DID. A NON-`did:cid` subject makes this a
   * genuine foreign issue — `issueCredential` encrypts-to-issuer and embeds the asset `id` under the proof,
   * so the VC is self-contained and portable to a holder that is not on Archon.
   */
  subjectDid: string;
  /** The Archon schema DID the fact conforms to. */
  schemaDid: string;
  /** The disclosed claims — the Warden's issuer-attested fact. */
  claims: Record<string, unknown>;
  /**
   * Short-lived by design: a push is a snapshot, not a live proof, so it expires and the verifier re-checks.
   * ISO-8601; strongly recommended for a foreign disclosure.
   */
  validUntil?: string;
  /** Optional human-readable comment carried in the issue-credential message body. */
  comment?: string;
}

export interface ForeignDisclosureResult {
  /** Whether the release ladder allowed the disclosure. When false, NOTHING was minted or sent. */
  released: boolean;
  /** The `decideRelease` reason (allow or deny), surfaced for audit. */
  reason: string;
  /** The issued VC's asset DID — present iff `released`. This is what the recipient resolves to verify. */
  credentialDid?: string;
}

/**
 * Issuer side (Warden): mint an issuer-attested VC for a subject that may be OUTSIDE Archon and push it
 * WHOLE to `toDid` over DIDComm's issue-credential/3.0.
 *
 * Deny-by-default: the disclosure MUST clear `decideRelease(release)` FIRST, and the gate is INSIDE this
 * path — no caller can emit a foreign VC without crossing the ladder (a sensitive field is refused unless
 * the passed `tier` already reflects the Sovereign co-sign that cleared it; `decideRelease` is pure, the
 * step-up is the caller's job and its RESULT is the tier here). On denial this returns `{released:false}`
 * having minted and sent nothing.
 *
 * Choosing the recipient here is not a confused deputy: this is the owner disclosing her own fact by her own
 * act (the Blazon publish), not a delegated agent forging-for-a-peer — that guard lives on the *prove* path.
 */
export async function discloseToForeignVerifier(
  issuer: KeymasterHandle,
  issuerName: string,
  release: ReleaseContext,
  args: ForeignDisclosureArgs,
): Promise<ForeignDisclosureResult> {
  const decision = decideRelease(release);
  if (!decision.allow) {
    // Fail closed BEFORE any mint/send — a denied disclosure leaves no trace on the wire or the registry.
    return { released: false, reason: `release denied: ${decision.reason}` };
  }

  const km = issuer.keymaster;

  // use-id guard (same reasoning as deliverCredential): setCurrentId returns false for an unknown name
  // instead of throwing, so a typo'd issuer would silently sign as whoever is current. Fail loud.
  const ids = await km.listIds();
  if (!ids.includes(issuerName)) {
    throw new Error(
      `discloseToForeignVerifier: unknown issuer identity '${issuerName}' (wallet has: ${ids.join(', ') || 'none'})`,
    );
  }
  await km.setCurrentId(issuerName);

  // Mint the issuer-attested VC. A non-`did:cid` subject ⇒ issueCredential encrypts-to-issuer and embeds the
  // asset id under the proof (#108), so the credential is self-contained and verifiable off-network.
  const bound = await km.bindCredential(args.subjectDid, {
    schema: args.schemaDid,
    validUntil: args.validUntil,
    claims: args.claims,
  });
  const credentialDid = await km.issueCredential(bound, {
    schema: args.schemaDid,
    validUntil: args.validUntil,
  });

  // Deliver the SIGNED CREDENTIAL ITSELF, addressed to the foreign DID. Verification is the recipient's job:
  // resolve the issuer's did:cid (any Universal Resolver with the did:cid driver), check the proof — never
  // the sender's word, never a gateway's.
  await km.sendCredentialDidComm(credentialDid, args.toDid, {
    name: issuerName,
    ...(args.comment ? { comment: args.comment } : {}),
  });

  return { released: true, reason: decision.reason, credentialDid };
}
