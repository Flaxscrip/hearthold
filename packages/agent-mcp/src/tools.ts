/**
 * The Hearthold custodian tool set — `hearthold_*` verbs that AUGMENT Archon's `archon_*` tools (which stay
 * in `@didcid/mcp-server`, configured as a sibling). Every tool acts "as me" (the bound identity); none
 * reimplements a keymaster primitive — the two keymaster-direct tools (`whoami`, `read_card`) COMPOSE the
 * Archon keymaster the shared runtime already holds, and the rest are thin facades over the agent's own
 * Warden/Signet/Emissary control planes. Tool shapes mirror the Table's `DataSource` verbs (one control
 * surface, two clients).
 */

import type { ArchonRuntime } from '@didcid/mcp-server';

import type { HeartholdControlConfig } from './config.js';

/** The bound keymaster, or a clear error (a passphrase is required to operate the agent key). */
function boundKeymaster(runtime: ArchonRuntime): NonNullable<ArchonRuntime['keymaster']> {
  if (!runtime.keymaster) throw new Error('no keymaster in the bound runtime (a passphrase is required to operate the agent key)');
  return runtime.keymaster;
}

export interface HeartholdToolContext {
  runtime: ArchonRuntime;
  control: HeartholdControlConfig;
  /** The bound identity, resolved once at startup. */
  identity: { did: string; name: string };
}

export interface HeartholdTool {
  name: string;
  description: string;
  /** JSON Schema (draft-07-ish) for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  handler: (ctx: HeartholdToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

/** Thin control-plane facade. A missing URL is a clear, actionable error (the read tools still work). */
async function control(
  ctx: HeartholdToolContext,
  base: string | undefined,
  which: 'Warden' | 'Signet' | 'Emissary',
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown> {
  if (!base) {
    throw new Error(
      `this tool needs the ${which} control URL (set HEARTHOLD_${which.toUpperCase()}_CONTROL_URL) — ` +
        `the keymaster-direct tools (hearthold_whoami / hearthold_read_card) work without it`,
    );
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(ctx.control.token ? { 'x-hearthold-session': ctx.control.token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${which} ${method} ${path} → ${res.status}: ${typeof json === 'object' ? JSON.stringify(json) : String(text)}`);
  return json;
}

export const HEARTHOLD_TOOLS: HeartholdTool[] = [
  {
    name: 'hearthold_whoami',
    description:
      'Who am I, as bound? My DID, wallet name, the registry my identity lives on, and the gatekeeper — proves the identity binding ("which Sovereign am I, in which registry"). Mirrors DataSource.snapshot (identity half).',
    inputSchema: NO_ARGS,
    async handler(ctx) {
      const km = boundKeymaster(ctx.runtime);
      const doc = (await km.resolveDID(ctx.identity.did).catch(() => null)) as Record<string, any> | null;
      const registry = doc?.didDocumentRegistration?.registry ?? doc?.mdip?.registry ?? undefined;
      return { did: ctx.identity.did, name: ctx.identity.name, identityRegistry: registry };
    },
  },
  {
    name: 'hearthold_read_card',
    description:
      'Read a card addressed to me — resolve + decrypt AS ME, auto-picking the format (a held credential, or a sealed message/JSON). No caller guesswork: the exact read that used to need a hand-rolled keymaster script. Composes the Archon keymaster; does not reimplement it.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string', description: 'the DID of the credential or sealed asset passed to me' } },
      required: ['did'],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const did = String(args.did ?? '');
      if (!did.startsWith('did:')) throw new Error('read_card needs a did: identifier');
      const km = boundKeymaster(ctx.runtime);
      // 1) a held verifiable credential?
      const vc = await km.getCredential(did).catch(() => null);
      if (vc && typeof vc === 'object') return { kind: 'credential', credential: vc };
      // 2) a sealed message/JSON — decryptMessage subsumes decryptJSON (JSON is just a stringified message).
      try {
        const text = await km.decryptMessage(did);
        try {
          return { kind: 'json', data: JSON.parse(text) };
        } catch {
          return { kind: 'message', text };
        }
      } catch (err) {
        throw new Error(`could not read ${did} as me — not a credential and not decryptable to this identity (${err instanceof Error ? err.message : String(err)})`);
      }
    },
  },
  {
    name: 'hearthold_list_inbound',
    description: 'Cards passed to me from other nodes, verified but not yet accepted into my vault. Mirrors DataSource.inbound.',
    inputSchema: NO_ARGS,
    handler: (ctx) => control(ctx, ctx.control.wardenUrl, 'Warden', 'GET', '/api/card/inbound'),
  },
  {
    name: 'hearthold_recall',
    description: 'Recall from my own vault — a draft answer over my witnessed history, gated by my ceiling. Mirrors DataSource.divine.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxSensitivity: { type: 'string', description: 'optional ceiling name, e.g. LOW/MEDIUM/HIGH' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/recall', { query: a.query, maxSensitivity: a.maxSensitivity }),
  },
  {
    name: 'hearthold_contribute',
    description: 'Contribute an observation to my home vault via my Emissary (born-obsidian → triage). Mirrors DataSource.contribute. Images route to the image Emissary by kind.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        text: { type: 'string' },
        attachment: {
          type: 'object',
          properties: { mediaType: { type: 'string' }, bytesB64: { type: 'string' } },
          required: ['mediaType', 'bytesB64'],
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.emissaryUrl, 'Emissary', 'POST', '/api/submit', { kind: a.kind, text: a.text, attachment: a.attachment }),
  },
  {
    name: 'hearthold_pass_card',
    description: 'Pass a card I hold to another DID (optionally recipient-sealed/readable). Mirrors DataSource.passCard.',
    inputSchema: {
      type: 'object',
      properties: {
        toDid: { type: 'string' },
        cardDid: { type: 'string' },
        readable: { type: 'boolean' },
      },
      required: ['toDid', 'cardDid'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/card/pass', { toDid: a.toDid, credentialDid: a.cardDid, readable: a.readable }),
  },
  {
    name: 'hearthold_accept_card',
    description: 'Accept an inbound card into my vault. Mirrors DataSource.acceptCard.',
    inputSchema: { type: 'object', properties: { credentialDid: { type: 'string', description: 'the inbound card’s VC asset DID' } }, required: ['credentialDid'], additionalProperties: false },
    handler: (ctx, a) => control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/card/accept', { credentialDid: a.credentialDid }),
  },
  {
    name: 'hearthold_decline_card',
    description: 'Decline an inbound card (fail-closed, nothing enters my vault).',
    inputSchema: { type: 'object', properties: { credentialDid: { type: 'string', description: 'the inbound card’s VC asset DID' } }, required: ['credentialDid'], additionalProperties: false },
    handler: (ctx, a) => control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/card/decline', { credentialDid: a.credentialDid }),
  },
  {
    name: 'hearthold_forge',
    description: 'Forge an attestation over my witnessed history — issuer-attested evidence, optionally recipient-sealed. Mirrors DataSource.forge. As an agent Sovereign this signs autonomously within my allowance; sensitive forges escalate to my parent.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: { type: 'string' },
        kind: { type: 'string' },
        recipientDid: { type: 'string' },
      },
      required: ['claim', 'kind'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/forge', { claim: a.claim, kind: a.kind, recipientDid: a.recipientDid }),
  },
  {
    name: 'hearthold_triage',
    description: 'My born-obsidian triage queue — proposals not yet admitted. Mirrors DataSource.triage.',
    inputSchema: NO_ARGS,
    handler: (ctx) => control(ctx, ctx.control.wardenUrl, 'Warden', 'GET', '/api/triage'),
  },
  {
    name: 'hearthold_confirm_triage',
    description: 'Admit a triaged proposal at a chosen sensitivity (0=PUBLIC…4=SEALED). Mirrors DataSource.confirmTriage.',
    inputSchema: {
      type: 'object',
      properties: { artefactId: { type: 'string' }, sensitivity: { type: 'number', description: '0 PUBLIC · 1 LOW · 2 MEDIUM · 3 HIGH · 4 SEALED' } },
      required: ['artefactId', 'sensitivity'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/triage/confirm', { artefactId: a.artefactId, sensitivity: a.sensitivity }),
  },
  {
    name: 'hearthold_pending_approvals',
    description: 'Approvals pending at my Signet — for an agent that is itself a parent over its own sub-agents. Reads my Signet snapshot.',
    inputSchema: NO_ARGS,
    async handler(ctx) {
      const snap = (await control(ctx, ctx.control.signetUrl, 'Signet', 'GET', '/api/snapshot')) as { pending?: unknown };
      return { pending: snap.pending ?? [] };
    },
  },
  {
    name: 'hearthold_decide',
    description: 'Decide a pending approval at my Signet (approve/decline). Decline is fail-closed and needs no PIN; approving a spend is entered at the Signet, not here.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, approve: { type: 'boolean' }, pin: { type: 'string' } },
      required: ['id', 'approve'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.signetUrl, 'Signet', 'POST', '/api/approve', { id: a.id, approve: a.approve, pin: a.pin }),
  },
];
