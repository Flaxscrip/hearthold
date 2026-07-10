/**
 * CGPR — Consent-Gated Preference Requests. The A2A extension contract (Autoura / DIF H&T WG).
 *
 * Consumer A ↔ broker B ↔ subcontractor C. C needs A's preferences; B must never see them and must
 * never get a reusable identifier for A before A approves. These four objects are the wire contract at
 * the A2A boundary. Two invariants are structural, not conventional:
 *
 *   1. **No subject identifier before approval.** `CgprTicket` and `CgprRequestArtifact` have NO field
 *      for A's identity, and `additionalProperties: false` makes one *impossible to add*, not merely
 *      optional (conformance rule #1). The subject appears only in `CgprGrant.credential`, and there it
 *      is a fresh H1 pairwise DID — never A's stable DID.
 *   2. **Denials leak nothing.** `CgprDecision` is `{ ticketId, decision: 'denied' }` and nothing else —
 *      no reason string (a reason can leak).
 *
 * draft-07, repo convention: `title` = the object type. Registered as Archon schema DIDs
 * (`registerCgprSchemas`) so the same shapes verify on both sides of the bridge. Migrate the extension
 * URI to a DIF-owned URI if/when the WG adopts it — it lives in one constant.
 */

import { ensureSchema, type KeymasterHandle } from '@hearthold/core';

/** The A2A AgentExtension URI advertised in the Agent Card. One constant — swap for a DIF URI later. */
export const CGPR_EXTENSION_URI = 'https://hearthold.dev/2026/a2a/cgpr/v1';

// ── TypeScript wire types ─────────────────────────────────────────────────────

/** A→C privacy directives carried on the ticket (advisory to C; the Warden enforces its own policy). */
export interface CgprPrivacyControls {
  retention?: string;
  sharing?: string;
}

/**
 * B → C. Authorizes C to request a bounded set of A's preferences. Note the ABSENCE of any subject
 * field: a ticket cannot name A. Single-use by construction.
 */
export interface CgprTicket {
  ticketId: string;
  expiresAt: string;
  singleUse: true;
  /** HATPro vocabulary paths, e.g. "foodAndBeverage.dietaryRestrictions". */
  scopes: string[];
  purpose: string;
  privacyControls?: CgprPrivacyControls;
}

/** C's self-description — C identifying ITSELF (for audience-binding), never A. */
export interface CgprRequester {
  /** C's DID, used to audience-bind the resulting grant. Provide this or `keyJwk`. */
  did?: string;
  /** Raw key material for audience-binding when C has no DID. */
  keyJwk?: Record<string, unknown>;
  agentCardUrl: string;
}

/** C → gateway. The ticket plus C's self-description and the lifetime C requests for the grant. */
export interface CgprRequestArtifact {
  ticket: CgprTicket;
  requester: CgprRequester;
  validForMinutes: number;
}

/** The deny path. Carries the ticketId and nothing else — no reason. */
export interface CgprDecision {
  ticketId: string;
  decision: 'denied';
}

/** The approve path. The attestation VC's subject is a fresh H1 pairwise DID. Single-use. */
export interface CgprGrant {
  ticketId: string;
  /** The attestation VC (subject = H1 pairwise DID). */
  credential: Record<string, unknown>;
  schemaDid: string;
  validUntil: string;
  singleUse: true;
}

// ── draft-07 JSON Schemas ─────────────────────────────────────────────────────

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/** Shared ticket property block — reused as `CgprRequestArtifact.ticket` so the shapes can't drift. */
const ticketShape = {
  type: 'object',
  additionalProperties: false,
  required: ['ticketId', 'expiresAt', 'singleUse', 'scopes', 'purpose'],
  properties: {
    ticketId: { type: 'string', format: 'uuid' },
    expiresAt: { type: 'string', format: 'date-time' },
    singleUse: { const: true },
    scopes: { type: 'array', items: { type: 'string' }, minItems: 1 },
    purpose: { type: 'string' },
    privacyControls: {
      type: 'object',
      additionalProperties: false,
      properties: {
        retention: { type: 'string' },
        sharing: { type: 'string' },
      },
    },
  },
} as const;

export const CgprTicketSchema = {
  $schema: DRAFT_07,
  title: 'CgprTicket',
  ...ticketShape,
} as const;

export const CgprRequestArtifactSchema = {
  $schema: DRAFT_07,
  title: 'CgprRequestArtifact',
  type: 'object',
  additionalProperties: false,
  required: ['ticket', 'requester', 'validForMinutes'],
  properties: {
    ticket: ticketShape,
    requester: {
      type: 'object',
      additionalProperties: false,
      required: ['agentCardUrl'],
      properties: {
        did: { type: 'string' },
        keyJwk: { type: 'object' },
        agentCardUrl: { type: 'string', format: 'uri' },
      },
    },
    validForMinutes: { type: 'integer', minimum: 1 },
  },
} as const;

export const CgprDecisionSchema = {
  $schema: DRAFT_07,
  title: 'CgprDecision',
  type: 'object',
  additionalProperties: false,
  required: ['ticketId', 'decision'],
  properties: {
    ticketId: { type: 'string', format: 'uuid' },
    decision: { const: 'denied' },
  },
} as const;

export const CgprGrantSchema = {
  $schema: DRAFT_07,
  title: 'CgprGrant',
  type: 'object',
  additionalProperties: false,
  required: ['ticketId', 'credential', 'schemaDid', 'validUntil', 'singleUse'],
  properties: {
    ticketId: { type: 'string', format: 'uuid' },
    credential: { type: 'object' },
    schemaDid: { type: 'string' },
    validUntil: { type: 'string', format: 'date-time' },
    singleUse: { const: true },
  },
} as const;

/** The four CGPR schemas by title — the object type is the key (registration + lookup). */
export const CGPR_SCHEMAS = {
  CgprTicket: CgprTicketSchema,
  CgprRequestArtifact: CgprRequestArtifactSchema,
  CgprDecision: CgprDecisionSchema,
  CgprGrant: CgprGrantSchema,
} as const;

export type CgprSchemaName = keyof typeof CGPR_SCHEMAS;

/**
 * Register all four CGPR schemas as Archon schema DIDs on `handle` (idempotent via `ensureSchema`).
 * Returns `{ CgprTicket: <did>, … }` so both sides of the bridge verify against the same shapes.
 */
export async function registerCgprSchemas(handle: KeymasterHandle): Promise<Record<CgprSchemaName, string>> {
  const out = {} as Record<CgprSchemaName, string>;
  for (const name of Object.keys(CGPR_SCHEMAS) as CgprSchemaName[]) {
    out[name] = await ensureSchema(handle, name, CGPR_SCHEMAS[name]);
  }
  return out;
}
