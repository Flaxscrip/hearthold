/**
 * Capabilities as Archon Verifiable Credentials.
 *
 * The Sovereign issues the Emissary a scope credential (a `HearthholdAuthorization` VC whose
 * credentialSubject IS the capability — invocationTarget, authority, caveats). The Warden then REQUESTS that
 * credential in the invocation challenge (`createChallenge({ credentials: [...] })`), and the Emissary
 * presents it. Presentation + holder-control + issuer-trust collapse into ONE native Archon ceremony
 * (`verifyResponse`), so the enforced scope is sound by construction — there is no wire body to forge, and no
 * bespoke commitment/chain to get wrong. This is the same primitive `prove.ts` uses for evidence, applied to
 * authorization. See docs/invocation.md and docs/attributions.md (Karp: an authorization is not a credential —
 * hence the explicit `HearthholdAuthorization` type).
 */

import type { KeymasterHandle } from './keymaster.js';
import type { AuthoritySet } from './attenuation.js';
import { ensureSchema, openSchema } from './schema.js';
import { issueClaim } from './credentials.js';
import { AUTHORIZATION_TYPE, normalizeCaveats, type Caveats } from './capability.js';

export const AUTHORIZATION_SCHEMA_NAME = 'HearthholdAuthorization';

/**
 * Register (idempotent) the HearthholdAuthorization schema and return its DID. Schema DIDs are
 * content-addressed, so every wallet that registers the same schema JSON derives the SAME DID — the Sovereign
 * issues against it and the Warden requests it without any shared configuration.
 */
export async function ensureAuthorizationSchema(handle: KeymasterHandle): Promise<string> {
  return ensureSchema(handle, AUTHORIZATION_SCHEMA_NAME, openSchema(AUTHORIZATION_TYPE));
}

/** The parts of a capability a Sovereign grants (id/holder/issuer are the VC's own subject/issuer). */
export interface ScopeSpec {
  invocationTarget: string;
  authority: AuthoritySet;
  caveats: Caveats;
}

/**
 * The Sovereign (issuer) issues a scope-capability VC to `holder`. Returns the VC DID; the holder then
 * `acceptCredential`s it so it can be presented. Delegation depth is one hop here — multi-hop attenuation
 * (Emissary → third party) is the attenuation-chain primitive, kept separate.
 */
export async function issueScopeCapability(args: {
  issuer: KeymasterHandle;
  /** Wallet-id NAME of the issuing Sovereign (set current before binding/issuing). */
  issuerName: string;
  /** DID the capability is granted to (the VC subject / holder). */
  holder: string;
  /** The HearthholdAuthorization schema DID (from `ensureAuthorizationSchema`). */
  schemaDid: string;
  scope: ScopeSpec;
  validUntil?: string;
}): Promise<string> {
  await args.issuer.keymaster.setCurrentId(args.issuerName);
  const claims: Record<string, unknown> = {
    type: AUTHORIZATION_TYPE,
    authorizationType: 'capability',
    invocationTarget: args.scope.invocationTarget,
    authority: args.scope.authority,
    caveats: normalizeCaveats(args.scope.caveats),
  };
  return issueClaim(args.issuer, args.holder, args.schemaDid, claims, args.validUntil);
}
