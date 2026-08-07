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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import type { AuthoritySet } from './attenuation.js';
import type { HearthholdConfig } from './config.js';
import { ensureSchema, openSchema } from './schema.js';
import { issueClaim } from './credentials.js';
import { AUTHORIZATION_TYPE, normalizeCaveats, type Caveats } from './capability.js';
import { createStatusList, STATUS_LIST_LENGTH } from './status-list.js';
import { createAllocationRecord, allocateIndex } from './allocation.js';

export const AUTHORIZATION_SCHEMA_NAME = 'HearthholdAuthorization';

/**
 * Get-or-create the issuer's capability-revocation context — one W3C StatusList + one durable allocation
 * record, persisted in the issuer's data folder so every capability it mints draws a fresh, collision-free
 * index from the same list. Batteries-included: `issueScopeCapability` calls this so a capability is revocable
 * by default (audit-3 §4), rather than needing the caller to stand up a status list by hand.
 */
export async function ensureCapabilityStatusContext(
  issuer: KeymasterHandle,
  issuerName: string,
  config: HearthholdConfig,
): Promise<{ statusListCredential: string; allocationRecord: string }> {
  const file = join(issuer.dataFolder, 'capability-status.json');
  let cur: { statusListCredential?: string; allocationRecord?: string } = {};
  try {
    cur = JSON.parse(await readFile(file, 'utf8')) as typeof cur;
  } catch {
    /* first use */
  }
  if (cur.statusListCredential && cur.allocationRecord) {
    return { statusListCredential: cur.statusListCredential, allocationRecord: cur.allocationRecord };
  }
  const { statusListCredential } = await createStatusList(issuer, issuerName, config);
  const allocationRecord = await createAllocationRecord(issuer, issuerName, config);
  await mkdir(issuer.dataFolder, { recursive: true });
  await writeFile(file, JSON.stringify({ statusListCredential, allocationRecord }, null, 2), 'utf8');
  return { statusListCredential, allocationRecord };
}

/**
 * Register (idempotent) the HearthholdAuthorization schema and return its DID. A `did:cid` schema is registered
 * ONCE (the registrant is its Controller) and is then resolvable + reusable by any issuer in the same registry
 * sphere — so the canonical model is *one schema, many issuers*: one agent registers it here, and everyone else
 * reuses that DID (`config.authorizationSchemaDid`) rather than registering a duplicate.
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
  /**
   * When given (and `scope.caveats.status` is not set explicitly), the capability is minted **revocable**: a
   * fresh index is allocated from the issuer's status context and written into `caveats.status`. Omit only for
   * a capability that is deliberately non-revocable (the Warden may then refuse it — see
   * `config.requireRevocableCapabilities`).
   */
  config?: HearthholdConfig;
}): Promise<string> {
  await args.issuer.keymaster.setCurrentId(args.issuerName);
  // Revocation by default: allocate a status index unless the caller pinned one (the revoke e2e's manual path).
  const caveats: Caveats = { ...args.scope.caveats };
  if (!caveats.status && args.config) {
    const ctx = await ensureCapabilityStatusContext(args.issuer, args.issuerName, args.config);
    const { index } = await allocateIndex(args.issuer, args.issuerName, ctx.allocationRecord, randomUUID(), STATUS_LIST_LENGTH);
    caveats.status = { statusListCredential: ctx.statusListCredential, statusListIndex: index };
  }
  const claims: Record<string, unknown> = {
    type: AUTHORIZATION_TYPE,
    authorizationType: 'capability',
    invocationTarget: args.scope.invocationTarget,
    authority: args.scope.authority,
    caveats: normalizeCaveats(caveats),
  };
  return issueClaim(args.issuer, args.holder, args.schemaDid, claims, args.validUntil);
}
