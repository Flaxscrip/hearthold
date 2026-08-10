import type { VerifiableCredential } from '@didcid/keymaster/types';

import type { KeymasterHandle } from './keymaster.js';
import type { WitnessKind } from './protocol.js';

/** Credential type markers used in Hearthold claims. */
export const CredentialType = {
  DELEGATION: 'HearthholdDelegation',
  ATTESTATION: 'HearthholdAttestation',
} as const;

/**
 * `issueCredential`, resilient to a transient "does not contain any verification methods" on the subject-encrypt.
 *
 * keymaster's `issueCredential` encrypts the VC to the subject via `resolveDID(subject, {confirm: true})` — the
 * CONFIRMED view (`encryptMessage`, keymaster.js). For a **cross-node / federated subject** that confirmed view
 * can briefly lag the latest (the subject's key update hasn't been confirmed on the *resolving* gatekeeper yet),
 * so the encrypt throws even though a `latest` resolve — and a standalone `encryptMessage` that raced ahead —
 * sees the key. This is why a readiness gate that resolves *latest* does NOT help: `issueCredential` resolves
 * *confirmed*. The gate here uses the SAME confirmed view, drains `processEvents`, and retries a bounded number
 * of times. Passthrough on the happy path (the single-node/local case never trips it). Only the specific
 * confirmed-lag error is retried; any other error propagates immediately.
 */
export async function issueCredentialResilient(
  issuer: KeymasterHandle,
  credential: { credentialSubject?: { id?: string } } & Record<string, unknown>,
  options: Record<string, unknown> = {},
  cfg: { attempts?: number; backoffMs?: number } = {},
): Promise<string> {
  const km = issuer.keymaster as unknown as {
    issueCredential: (c: unknown, o: unknown) => Promise<string>;
    resolveDID: (d: string, o?: unknown) => Promise<unknown>;
    processEvents?: () => Promise<unknown>;
  };
  const subject = credential.credentialSubject?.id;
  const attempts = Math.max(1, cfg.attempts ?? 4);
  const backoffMs = cfg.backoffMs ?? 400;

  const confirmedHasVerificationMethod = async (did: string): Promise<boolean> =>
    km
      .resolveDID(did, { confirm: true })
      .then((d) => ((d as { didDocument?: { verificationMethod?: unknown[] } })?.didDocument?.verificationMethod?.length ?? 0) > 0)
      .catch(() => false);
  const settle = async (): Promise<void> => {
    try {
      await km.processEvents?.();
    } catch {
      /* federated subjects confirm via gossip, not our queue — the backoff below is the real wait */
    }
    await new Promise((r) => setTimeout(r, backoffMs));
  };

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    // After a first failure, gate on the confirmed view actually carrying the subject's key before retrying.
    if (i > 0 && subject && !(await confirmedHasVerificationMethod(subject))) {
      await settle();
      continue;
    }
    try {
      return await km.issueCredential(credential, options);
    } catch (e) {
      lastErr = e;
      if (!/verification methods/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await settle();
    }
  }
  throw new Error(
    `issueCredentialResilient: subject-encrypt kept failing on the confirmed resolution of ${subject ?? '(no subject)'} after ${attempts} attempts — ` +
      `the subject's key is not confirmed on this gatekeeper (a federated subject whose update hasn't propagated). ` +
      `Last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** Scope of authority the Warden grants the Emissary. */
export interface DelegationScope {
  /** Which witness/claim kinds the Emissary may request evidence about. */
  kinds: WitnessKind[];
  /** ISO timestamp after which the delegation is no longer valid. */
  validUntil: string;
  /**
   * The household member (Sovereign) this Emissary submits on behalf of — carried IN the credential so the
   * owner is read from the presented delegation, not a local map. Absent ⇒ single-Sovereign (owner defaults).
   */
  member?: string;
}

/**
 * Warden issues a revocable delegation credential to the Emissary, bound to the delegation schema
 * so challenge/response can match it. Returns the credential DID. The Warden must be the current
 * identity on `warden`.
 */
export async function issueDelegation(
  warden: KeymasterHandle,
  emissaryDid: string,
  schemaDid: string,
  scope: DelegationScope,
): Promise<string> {
  const bound = await warden.keymaster.bindCredential(emissaryDid, {
    schema: schemaDid,
    validUntil: scope.validUntil,
    claims: {
      type: CredentialType.DELEGATION,
      kinds: scope.kinds,
      ...(scope.member ? { member: scope.member } : {}),
    },
  });
  return warden.keymaster.issueCredential(bound, { schema: schemaDid, validUntil: scope.validUntil });
}

/**
 * Issue a credential of arbitrary claims to a subject, bound to `schemaDid`. The issuer must be the
 * current identity on `issuer`. Returns the credential DID. (This is how a Sovereign acts as an
 * issuer — e.g. a sphere manager issuing membership or raid tickets to gamers.)
 */
export async function issueClaim(
  issuer: KeymasterHandle,
  subjectDid: string,
  schemaDid: string,
  claims: Record<string, unknown>,
  validUntil?: string,
): Promise<string> {
  const bound = await issuer.keymaster.bindCredential(subjectDid, { schema: schemaDid, validUntil, claims });
  return issuer.keymaster.issueCredential(bound, { schema: schemaDid, validUntil });
}

/** Accept any credential issued to this identity into its wallet. */
export async function acceptCredential(
  handle: KeymasterHandle,
  credentialDid: string,
): Promise<boolean> {
  return handle.keymaster.acceptCredential(credentialDid);
}

/** Emissary accepts a delegation credential into its wallet. */
export async function acceptDelegation(
  witness: KeymasterHandle,
  credentialDid: string,
): Promise<boolean> {
  return witness.keymaster.acceptCredential(credentialDid);
}

/** Warden revokes a previously issued credential (delegation or attestation). */
export async function revokeCredential(
  warden: KeymasterHandle,
  credentialDid: string,
): Promise<boolean> {
  return warden.keymaster.revokeCredential(credentialDid);
}

/**
 * Mint a selective-disclosure attestation: a derived credential asserting a fact about the
 * Sovereign's history WITHOUT exposing the source artefact. This is what crosses the boundary
 * when the Emissary needs to prove something in the world.
 */
export async function mintAttestation(
  warden: KeymasterHandle,
  subjectDid: string,
  claim: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const bound = await warden.keymaster.bindCredential(subjectDid, {
    claims: {
      type: CredentialType.ATTESTATION,
      claim,
      ...fields,
    },
  });
  return warden.keymaster.issueCredential(bound);
}

/** Fetch and return a stored credential, or null. */
export async function getCredential(
  handle: KeymasterHandle,
  credentialDid: string,
): Promise<VerifiableCredential | null> {
  return handle.keymaster.getCredential(credentialDid);
}
