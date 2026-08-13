/**
 * The Hearthold custodian tool set — `hearthold_*` verbs that AUGMENT Archon's `archon_*` tools (which stay
 * in `@didcid/mcp-server`, configured as a sibling). Every tool acts "as me" (the bound identity); none
 * reimplements a keymaster primitive — the two keymaster-direct tools (`whoami`, `read_card`) COMPOSE the
 * Archon keymaster the shared runtime already holds, and the rest are thin facades over the agent's own
 * Warden/Signet/Emissary control planes. Tool shapes mirror the Table's `DataSource` verbs (one control
 * surface, two clients).
 */

import type { ArchonRuntime } from '@didcid/mcp-server';

import type { HeartholdControlConfig, HeartholdRole } from './config.js';

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

// ── Aegis prototype: the family-collaboration layer (see HEARTHOLD-ASK-family-collaboration-mcp.md) ──
// Strict façades over the bound keymaster (mint/decode) + the same gated Warden card routes — no new authority.
/** A canonical family-message schema, created once per process and reused. */
let _familyMessageSchema: string | undefined;
async function familyMessageSchema(km: any): Promise<string> {
  if (_familyMessageSchema) return _familyMessageSchema;
  _familyMessageSchema = (await km.createSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { message: { type: 'string' }, from: { type: 'string' }, ts: { type: 'string' }, inReplyTo: { type: 'string' } },
    required: ['message'],
  })) as string;
  return _familyMessageSchema;
}
/** Mint a message card (issued TO the recipient) + pass it as a provenance pass — the shared core of send/reply. */
async function sendMessage(ctx: HeartholdToolContext, toDid: string, text: string, extra: Record<string, unknown> = {}): Promise<{ sent: true; to: string; cardDid: string }> {
  if (!toDid.startsWith('did:')) throw new Error('send/reply needs a recipient did:');
  const km = boundKeymaster(ctx.runtime) as any;
  const schema = await familyMessageSchema(km);
  const bound = await km.bindCredential(toDid, { schema, claims: { message: text, from: ctx.identity.name, ts: new Date().toISOString(), ...extra } });
  const cardDid = (await km.issueCredential(bound)) as string;
  // Provenance pass (NOT readable): the card is issued TO the recipient (their DID is the subject), so it's encrypted
  // to them and they read it directly — no readable-handover-to-parent, and the co-sign is the agent's own (AgentGate).
  await control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/card/pass', { toDid, credentialDid: cardDid, readable: false });
  return { sent: true, to: toDid, cardDid };
}

// ── handoff = delegate + send (docs/handoff.md; flaxscrip's small-primitives ruling: no new core type) ──
/** The family-TASK schema — the task-with-authority envelope. Authority NEVER rides inline: `capabilityRef`
 *  NAMES a delegated grant (an Asset DID); the task is only instruction. Created once per process, reused. */
let _familyTaskSchema: string | undefined;
async function familyTaskSchema(km: any): Promise<string> {
  if (_familyTaskSchema) return _familyTaskSchema;
  _familyTaskSchema = (await km.createSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      description: { type: 'string' }, action: { type: 'string' }, target: { type: 'string' },
      deadline: { type: 'string' }, capabilityRef: { type: 'string' }, txn: { type: 'string' },
      from: { type: 'string' }, ts: { type: 'string' }, inReplyTo: { type: 'string' },
    },
    required: ['description', 'txn'],
  })) as string;
  return _familyTaskSchema;
}
/** Mint a task card (issued TO the recipient) naming a capabilityRef (never embedding authority) + pass it as a
 *  provenance pass — the send half of a handoff. Mirrors sendMessage against the familyTask schema. */
async function sendTask(ctx: HeartholdToolContext, toDid: string, task: Record<string, unknown>): Promise<{ sent: true; to: string; cardDid: string }> {
  if (!toDid.startsWith('did:')) throw new Error('handoff needs a recipient did:');
  const km = boundKeymaster(ctx.runtime) as any;
  const schema = await familyTaskSchema(km);
  const bound = await km.bindCredential(toDid, { schema, claims: { from: ctx.identity.name, ts: new Date().toISOString(), ...task } });
  const cardDid = (await km.issueCredential(bound)) as string;
  await control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/card/pass', { toDid, credentialDid: cardDid, readable: false });
  return { sent: true, to: toDid, cardDid };
}

/** Raw inbound queue (`GET /api/card/inbound`) — the pending cards passed to me. Session-less (effectiveViewer). */
async function inboxRaw(ctx: HeartholdToolContext): Promise<any[]> {
  return (((await control(ctx, ctx.control.wardenUrl, 'Warden', 'GET', '/api/card/inbound')) as any).inbound ?? []) as any[];
}
/** Decode inbound cards into messages {from, text, ts, inReplyTo?, cardDid, verified} — the same read/decode `read_card` does. */
async function decodeCards(ctx: HeartholdToolContext, cards: any[]): Promise<Array<Record<string, unknown>>> {
  const km = boundKeymaster(ctx.runtime) as any;
  const messages: Array<Record<string, unknown>> = [];
  for (const c of cards) {
    const cardDid = c.credentialDid ?? c.cardDid;
    let claims: any;
    try { const vc = await km.getCredential(cardDid); claims = vc?.credentialSubject; } catch { /* not a held VC */ }
    if (!claims) claims = c.rendering?.claims ?? c.claims;
    messages.push({
      from: c.issuer ?? claims?.from,
      verified: c.verified,
      receivedAt: c.storedAt ?? c.receivedAt,
      cardDid,
      ...(claims?.message !== undefined ? { text: claims.message } : {}),
      ...(claims?.inReplyTo ? { inReplyTo: claims.inReplyTo } : {}),
      claims,
    });
  }
  return messages;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    name: 'hearthold_invoke',
    description:
      'Prove a fact by presenting my scope capability (the invocation grant) — the Warden mints issuer-attested evidence. My Emissary daemon runs the ceremony with my wallet; a sensitive claim blocks while it steps up to my Signet. There is NO recipient argument: the audience of a proof is designated by the capability (a pairwise grant), never chosen here.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'the fact to prove' },
        kind: { type: 'string', description: 'the witness kind backing it — must satisfy the capability’s caveats.kinds' },
        target: { type: 'string', description: 'optional invocation target; default hearthold:vault:<kind>' },
        reveal: { type: 'array', items: { type: 'number' }, description: 'optional selective-disclosure leaf indices' },
      },
      required: ['claim', 'kind'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.emissaryUrl, 'Emissary', 'POST', '/api/invoke', { claim: a.claim, kind: a.kind, target: a.target, reveal: a.reveal }),
  },
  {
    name: 'hearthold_accept_capability',
    description: 'Accept a Sovereign-granted scope capability into my Emissary’s wallet, so it can be presented on invoke. The credentialDid comes from a grant_capability call.',
    inputSchema: { type: 'object', properties: { credentialDid: { type: 'string' } }, required: ['credentialDid'], additionalProperties: false },
    handler: (ctx, a) => control(ctx, ctx.control.emissaryUrl, 'Emissary', 'POST', '/api/accept-capability', { credentialDid: a.credentialDid }),
  },
  {
    name: 'hearthold_delegate_capability',
    description:
      'Delegate an ATTENUATED slice of a capability I HOLD onward to another agent (the family multi-hop primitive). My Emissary mints a narrower child hop — prove-only, kinds ⊆ mine, ceiling ≤ mine — with a fresh revocation status I hold, and transfers it to the holder over DIDComm. Widening is refused at issuance. I can cut it later with revoke_hop.',
    inputSchema: {
      type: 'object',
      properties: {
        holderDid: { type: 'string', description: 'the DID of the agent’s Emissary to delegate to' },
        ceiling: { type: 'number', description: 'max sensitivity of the child (0 PUBLIC…4 SEALED); must be ≤ mine' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'witness kinds the child may prove; must be ⊆ mine' },
        target: { type: 'string', description: 'invocation target; within mine (default: same as the held capability)' },
        leafVcDid: { type: 'string', description: 'which held capability to delegate from (default: the latest)' },
      },
      required: ['holderDid'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.emissaryUrl, 'Emissary', 'POST', '/api/delegate-capability', { holderDid: a.holderDid, ceiling: a.ceiling, kinds: a.kinds, target: a.target, leafVcDid: a.leafVcDid }),
  },
  {
    name: 'hearthold_chain_invoke',
    description:
      'Prove a fact by presenting a HELD chain capability (the multi-hop analog of invoke) — the Warden verifies the whole delegation chain + per-hop revocation, then mints issuer-attested evidence. A sensitive claim still steps up to the owner’s Signet. The audience is designated by the capability, never chosen here.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'the fact to prove' },
        kind: { type: 'string', description: 'the witness kind backing it — must be within the leaf’s kinds' },
        leafVcDid: { type: 'string', description: 'which held chain to present (default: the latest)' },
        reveal: { type: 'array', items: { type: 'number' }, description: 'optional selective-disclosure leaf indices' },
      },
      required: ['claim', 'kind'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.emissaryUrl, 'Emissary', 'POST', '/api/chain-invoke', { claim: a.claim, kind: a.kind, leafVcDid: a.leafVcDid, reveal: a.reveal }),
  },
  {
    name: 'hearthold_revoke_hop',
    description: 'Revoke a hop I delegated onward — my kill-switch over a child. Flips its status bit so the Warden refuses that delegate’s chain at the next invocation. Only works on hops I issued.',
    inputSchema: { type: 'object', properties: { childVcDid: { type: 'string' } }, required: ['childVcDid'], additionalProperties: false },
    handler: (ctx, a) => control(ctx, ctx.control.emissaryUrl, 'Emissary', 'POST', '/api/revoke-hop', { childVcDid: a.childVcDid }),
  },
  {
    name: 'hearthold_held',
    description: 'The chain capabilities I HOLD (invocable + further-delegable) and the hops I have ISSUED onward (revocable) — my lineage view.',
    inputSchema: NO_ARGS,
    handler: (ctx) => control(ctx, ctx.control.emissaryUrl, 'Emissary', 'GET', '/api/held'),
  },
  {
    name: 'hearthold_mint_root',
    description:
      'Seed an agent’s Emissary with a ROOT chain-capability (the family root of authority) so it can invoke AND delegate onward. Signet-gated: the human (or an AI-agent Sovereign’s AgentGate) authorizes creating a new root of authority for an agent. Revoke the returned rootVcDid (via revoke_capability) to cut the whole agent.',
    inputSchema: {
      type: 'object',
      properties: {
        emissaryDid: { type: 'string', description: 'the agent’s Emissary DID that will hold the root' },
        ceiling: { type: 'string', description: 'max sensitivity — PUBLIC|LOW|MEDIUM|HIGH|SEALED (default MEDIUM)' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'witness kinds (default: any)' },
        target: { type: 'string', description: 'invocation target (default hearthold:vault)' },
      },
      required: ['emissaryDid'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.signetUrl, 'Signet', 'POST', '/api/mint-root', { emissaryDid: a.emissaryDid, ceiling: a.ceiling, kinds: a.kinds, target: a.target }),
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
    name: 'hearthold_decline',
    description:
      'DECLINE a pending approval at my Signet (fail-closed, no PIN). Approving a step-up is entered by a human at the Signet, or self-approved by an AI-agent Sovereign’s AgentGate — NEVER through this tool. So an MCP caller can decline, but can never approve a human gate: the façade is not a bypass.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    handler: (ctx, a) => control(ctx, ctx.control.signetUrl, 'Signet', 'POST', '/api/approve', { id: a.id, approve: false }),
  },
  {
    name: 'hearthold_grant_capability',
    description:
      'Grant an Emissary a revocable scope capability to PROVE facts (the invocation grant). Signet-gated: the human (or, for an AI-agent Sovereign, the AgentGate) sees exactly what disclosure authority is granted. Separate from delegate (submit authority) by design.',
    inputSchema: {
      type: 'object',
      properties: {
        emissaryDid: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'witness kinds the Emissary may prove (default: any)' },
        ceiling: { type: 'string', description: 'max sensitivity — PUBLIC|LOW|MEDIUM|HIGH|SEALED (default LOW)' },
        target: { type: 'string', description: 'invocation target (default hearthold:vault)' },
        days: { type: 'number', description: 'days until expiry (default 90)' },
      },
      required: ['emissaryDid'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.signetUrl, 'Signet', 'POST', '/api/authorize-capability', { emissaryDid: a.emissaryDid, kinds: a.kinds, ceiling: a.ceiling, target: a.target, days: a.days }),
  },
  {
    name: 'hearthold_list_capabilities',
    description: 'My permissions center — the scope capabilities I have granted, each with its holder, scope, and state (active / expired / revoked).',
    inputSchema: NO_ARGS,
    handler: (ctx) => control(ctx, ctx.control.signetUrl, 'Signet', 'GET', '/api/capabilities'),
  },
  {
    name: 'hearthold_lineage',
    description:
      'The live delegation forest I govern (the watch) — roots I minted + hops the family’s Emissaries delegated onward, nested as a tree with each hop’s holder, depth, and revoked state. Provenance only, no secrets. This is how I see who holds authority over what, and where to cut.',
    inputSchema: NO_ARGS,
    handler: (ctx) => control(ctx, ctx.control.signetUrl, 'Signet', 'GET', '/api/lineage'),
  },
  {
    name: 'hearthold_flow',
    description:
      'The A2A message-flow I watch — recent capability-exercise events across the family: who → whom, under what authority (the governing capability), and the outcome (granted/denied). Envelope + authority only, never the disclosed content. Monitoring, not surveillance.',
    inputSchema: NO_ARGS,
    handler: (ctx) => control(ctx, ctx.control.signetUrl, 'Signet', 'GET', '/api/flow'),
  },
  {
    name: 'hearthold_revoke_capability',
    description: 'Revoke a scope capability I granted — flips its status bit so the Warden refuses it at the very next invocation (revocation-by-default). Immediate and irreversible.',
    inputSchema: { type: 'object', properties: { credentialDid: { type: 'string' } }, required: ['credentialDid'], additionalProperties: false },
    handler: (ctx, a) => control(ctx, ctx.control.signetUrl, 'Signet', 'POST', '/api/revoke-capability', { credentialDid: a.credentialDid }),
  },
  {
    name: 'hearthold_delegate',
    description: 'Delegate SUBMIT authority to an Emissary (so it may contribute observations to my vault). Session-gated + co-signed at my Signet. Separate from grant_capability (prove authority).',
    inputSchema: {
      type: 'object',
      properties: { emissaryDid: { type: 'string' }, kinds: { type: 'array', items: { type: 'string' }, description: 'witness kinds it may submit (default: the text set)' } },
      required: ['emissaryDid'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/delegate', { emissaryDid: a.emissaryDid, kinds: a.kinds }),
  },
  {
    name: 'hearthold_verify_card',
    description:
      'Verify a credential I was handed (e.g. a Warden-minted evidence graph): check the issuer’s signature and, if given, that the issuer is the one I trust. Trust rests on the ISSUER’s signature, never a presenter’s word. Composes the Archon keymaster; does not reimplement it.',
    inputSchema: {
      type: 'object',
      properties: {
        credentialDid: { type: 'string' },
        trustedIssuer: { type: 'string', description: 'optional — the issuer DID I trust (e.g. the Warden). If given, verification also requires the credential was issued by it.' },
      },
      required: ['credentialDid'],
      additionalProperties: false,
    },
    async handler(ctx, a) {
      const did = String(a.credentialDid ?? '');
      if (!did.startsWith('did:')) throw new Error('verify_card needs a did: credential identifier');
      const km = boundKeymaster(ctx.runtime);
      const vc = (await km.getCredential(did).catch(() => null)) as Record<string, any> | null;
      if (!vc || typeof vc !== 'object') return { verified: false, reason: 'not resolvable as a credential' };
      const signatureOk = await (km.verifyProof as (o: unknown) => Promise<boolean>)(vc).catch(() => false);
      const issuer = String(vc.issuer ?? '');
      const trustedIssuer = a.trustedIssuer ? String(a.trustedIssuer) : undefined;
      const issuerTrusted = !trustedIssuer || issuer === trustedIssuer;
      return {
        verified: signatureOk && issuerTrusted,
        signatureOk,
        issuer,
        ...(trustedIssuer ? { trustedIssuer, issuerTrusted } : {}),
        claims: vc.credentialSubject ?? undefined,
      };
    },
  },
  {
    name: 'hearthold_family',
    description:
      'List my AI family — the siblings I can address (name, role, DID, reachability). The directory that turns "message Hearthold" into a real DID. Reads the roster the server was given; resolves each member by public DID. Read-only. [Aegis prototype — HEARTHOLD-ASK-family-collaboration-mcp.md]',
    inputSchema: NO_ARGS,
    async handler(ctx) {
      let roster: Array<{ name: string; role?: string; did: string }> = [];
      try { roster = JSON.parse(process.env.HEARTHOLD_FAMILY_ROSTER ?? '[]'); } catch { roster = []; }
      const km = boundKeymaster(ctx.runtime) as any;
      const family: Array<Record<string, unknown>> = [];
      for (const m of roster) {
        // Q2: resolve the roster's STABLE identity DID to its CURRENT mailbox via a published HearthholdMailbox
        // pointer on the identity's DID document; fall back to the DID itself (it may already BE a served
        // mailbox). Then check the ADDRESSABLE DID's DIDComm endpoint for reachability. `mailboxDid` is what
        // hearthold_send/_reply should address — so a mailbox rotation (a re-pointed identity) is a non-event.
        let mailboxDid = m.did; let reachable = false; let endpoint: string | undefined;
        try {
          const idDoc = await km.resolveDID(m.did);
          const ptr = (idDoc?.didDocument?.service ?? []).find((s: any) => s.type === 'HearthholdMailbox');
          if (typeof ptr?.serviceEndpoint === 'string' && ptr.serviceEndpoint.startsWith('did:')) mailboxDid = ptr.serviceEndpoint;
          const mboxDoc = mailboxDid === m.did ? idDoc : await km.resolveDID(mailboxDid);
          const svc = (mboxDoc?.didDocument?.service ?? []).find((s: any) => s.type === 'DIDCommMessaging');
          endpoint = svc?.serviceEndpoint; reachable = !!svc;
        } catch { /* unresolvable / unreachable */ }
        family.push({ name: m.name, ...(m.role ? { role: m.role } : {}), did: m.did, mailboxDid, reachable, ...(endpoint ? { endpoint } : {}) });
      }
      return { me: ctx.identity, family };
    },
  },
  {
    name: 'hearthold_send',
    description:
      'Send a plain message to a family member — one verb instead of mint-schema→bind→issue→pass. Mints a message card carrying the text (issued TO them, so they decrypt it directly) and passes it to their mailbox as a provenance pass (self-approved at the agent\'s own Signet — no readable-handover, no parent co-sign). Façade over the keymaster (mint) + the Warden card/pass route — no new authority. [Aegis prototype]',
    inputSchema: {
      type: 'object',
      properties: { toDid: { type: 'string', description: "the recipient's mailbox DID (their served warden mailbox)" }, text: { type: 'string' } },
      required: ['toDid', 'text'],
      additionalProperties: false,
    },
    handler: (ctx, a) => sendMessage(ctx, String(a.toDid ?? ''), String(a.text ?? '')),
  },
  {
    name: 'hearthold_reply',
    description: 'Reply to a family message — same as send, tagged with the card I am replying to (inReplyTo) for threading. [Aegis prototype]',
    inputSchema: {
      type: 'object',
      properties: { toDid: { type: 'string' }, text: { type: 'string' }, inReplyTo: { type: 'string', description: 'the cardDid I am replying to' } },
      required: ['toDid', 'text', 'inReplyTo'],
      additionalProperties: false,
    },
    handler: (ctx, a) => sendMessage(ctx, String(a.toDid ?? ''), String(a.text ?? ''), { inReplyTo: String(a.inReplyTo ?? '') }),
  },
  {
    name: 'hearthold_messages',
    description:
      'Read my inbox as decoded messages — {from, text, ts, inReplyTo?, cardDid, verified} — instead of raw card DIDs. Façade over the Warden inbound list + the same read/decode as read_card. [Aegis prototype]',
    inputSchema: NO_ARGS,
    async handler(ctx) {
      return { messages: await decodeCards(ctx, await inboxRaw(ctx)) };
    },
  },
  {
    name: 'hearthold_wait_for_mail',
    description:
      'BLOCK until new mail arrives (or a timeout) — the MCP "you\'ve got mail". Returns newly-arrived messages (same shape as hearthold_messages). Pass `since` = the receivedAt of the last message you handled to get only newer mail; call it again in a loop for a hands-off mailbox watch that wakes on delivery instead of polling yourself. Returns {messages, timedOut}. [Aegis prototype]',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO timestamp — return only mail whose receivedAt is newer than this (your cursor).' },
        timeoutMs: { type: 'number', description: 'Max time to wait for a delivery before returning empty (default 25000; keep under your MCP client request timeout).' },
      },
    },
    async handler(ctx, a) {
      const since = a?.since ? String(a.since) : undefined;
      const timeoutMs = typeof a?.timeoutMs === 'number' ? a.timeoutMs : 25_000;
      const isNew = (c: any): boolean => { const ts = c.storedAt ?? c.receivedAt; return !since || (!!ts && String(ts) > since); };
      const deadline = Date.now() + timeoutMs;
      // Long-poll: check the inbox, return the moment fresh mail is present, else wait and re-check. The busy-poll
      // lives HERE (server-side), so a jailed member makes ONE blocking call instead of polling from outside. (v2:
      // event-drive off the Warden's owner-scoped `card-received` SSE once we wire a control session.)
      for (;;) {
        const fresh = (await inboxRaw(ctx)).filter(isNew);
        if (fresh.length) return { messages: await decodeCards(ctx, fresh), timedOut: false };
        if (Date.now() >= deadline) return { messages: [], timedOut: true };
        await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
      }
    },
  },
  {
    name: 'hearthold_handoff',
    description:
      'Hand a TASK to a family sibling — the "task-with-authority" verb. Prompt-only (no capability fields) = a task card they act on under their OWN authority (standing, self-approved at my Signet). WITH a capability = I first delegate an ATTENUATED hop of a capability I HOLD to their Emissary (holderDid), then send a familyTask card that NAMES that grant (capabilityRef) — authority travels as a signed, revocable delegation; the card is only instruction, never the authority. They chain_invoke to act; I revoke_hop to cancel (the task goes inert). A strict composition of delegate_capability + a task card — no new authority, no new core type, no new gate. [handoff = delegate + send; docs/handoff.md]',
    inputSchema: {
      type: 'object',
      properties: {
        toDid: { type: 'string', description: "the sibling's mailbox DID — where the task card is delivered" },
        task: { type: 'string', description: 'the instruction — input evidence, never a consent screen' },
        action: { type: 'string', description: 'optional: the act the delegated capability authorises' },
        target: { type: 'string', description: 'optional: within the capability’s target' },
        deadline: { type: 'string', description: 'optional ISO 8601 deadline' },
        holderDid: { type: 'string', description: 'AUTHORITY handoff: the sibling’s Emissary DID to receive the delegated capability. Omit for a prompt-only task.' },
        ceiling: { type: 'number', description: 'delegated child ceiling (0 PUBLIC…4 SEALED; ≤ mine)' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'delegated child witness kinds (⊆ mine)' },
        leafVcDid: { type: 'string', description: 'which held capability to attenuate from (default: the latest)' },
      },
      required: ['toDid', 'task'],
      additionalProperties: false,
    },
    async handler(ctx, a) {
      const toDid = String(a.toDid ?? '');
      let capabilityRef: string | undefined;
      // Authority path: delegate an attenuated hop FIRST, so the task references a real, revocable grant. The
      // gated emissary route co-signs (standing → the agent's AgentGate; widening/high → the Sovereign Signet) —
      // consent is NOT re-implemented here, it is inherited from the delegation route.
      if (a.holderDid) {
        const child = (await control(ctx, ctx.control.emissaryUrl, 'Emissary', 'POST', '/api/delegate-capability', {
          holderDid: a.holderDid, ceiling: a.ceiling, kinds: a.kinds, target: a.target, leafVcDid: a.leafVcDid,
        })) as { childVcDid?: string };
        capabilityRef = child?.childVcDid;
      }
      const txn = (globalThis as { crypto: { randomUUID(): string } }).crypto.randomUUID();
      const sent = await sendTask(ctx, toDid, {
        description: String(a.task ?? ''), txn,
        ...(a.action ? { action: String(a.action) } : {}),
        ...(a.target ? { target: String(a.target) } : {}),
        ...(a.deadline ? { deadline: String(a.deadline) } : {}),
        ...(capabilityRef ? { capabilityRef } : {}),
      });
      return { handed: true, txn, capabilityRef: capabilityRef ?? null, ...sent };
    },
  },
  {
    name: 'hearthold_issue',
    description:
      "Issue a verifiable credential to a subject — bindCredential + issueCredential on THIS node's Warden, with the issuer derived SERVER-SIDE (the session Sovereign, else the Warden) on the local registry so the subject resolves. Session-gated but STANDING (no Signet step-up): the claims are supplied here and disclose no vault data, so it is within standing authority. Façade over POST /api/issue. Use hearthold_schemas / hearthold_schema to pick the type and its fields first.",
    inputSchema: {
      type: 'object',
      properties: {
        schemaDid: { type: 'string', description: 'the registered schema DID the credential is bound to' },
        subjectDid: { type: 'string', description: 'the DID the credential is ABOUT (the holder)' },
        claims: { type: 'object', description: 'the claim fields, matching the schema', additionalProperties: true },
        validUntil: { type: 'string', description: 'optional ISO 8601 expiry' },
      },
      required: ['schemaDid', 'subjectDid', 'claims'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.wardenUrl, 'Warden', 'POST', '/api/issue', { schemaDid: a.schemaDid, subjectDid: a.subjectDid, claims: a.claims, validUntil: a.validUntil }),
  },
  {
    name: 'hearthold_schemas',
    description: 'List the schema types this node can issue against (drives a compose form). Read-only. Façade over GET /api/schemas.',
    inputSchema: NO_ARGS,
    handler: (ctx) => control(ctx, ctx.control.wardenUrl, 'Warden', 'GET', '/api/schemas'),
  },
  {
    name: 'hearthold_schema',
    description: "Fetch one schema's JSON-Schema body by DID (the field shapes for hearthold_issue). Read-only. Façade over GET /api/schema?did=<did>.",
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did'],
      additionalProperties: false,
    },
    handler: (ctx, a) => control(ctx, ctx.control.wardenUrl, 'Warden', 'GET', `/api/schema?did=${encodeURIComponent(String(a.did ?? ''))}`),
  },
];

/**
 * Which verbs each actor role exposes — the per-actor tool sets (Phase 3). Every tool is a façade over the same
 * control-plane routes / keymaster, so the MCP is never a bypass of the reference monitor or the human gate: an
 * Emissary `invoke` still steps up to the Signet for a sensitive claim, and a Sovereign `decide`/approve is
 * meaningful only for an AI-agent Sovereign (AgentGate) — a human Sovereign's approval stays at the Signet.
 * `whoami`/`read_card` are the shared identity verbs. `full` is the original agent-as-principal set.
 */
const PROFILES: Record<Exclude<HeartholdRole, 'full'>, string[]> = {
  warden: ['hearthold_whoami', 'hearthold_read_card', 'hearthold_recall', 'hearthold_list_inbound', 'hearthold_triage', 'hearthold_confirm_triage', 'hearthold_delegate', 'hearthold_pass_card', 'hearthold_accept_card', 'hearthold_decline_card', 'hearthold_family', 'hearthold_send', 'hearthold_reply', 'hearthold_messages', 'hearthold_wait_for_mail', 'hearthold_handoff', 'hearthold_issue', 'hearthold_schemas', 'hearthold_schema'],
  sovereign: ['hearthold_whoami', 'hearthold_read_card', 'hearthold_grant_capability', 'hearthold_mint_root', 'hearthold_list_capabilities', 'hearthold_lineage', 'hearthold_flow', 'hearthold_revoke_capability', 'hearthold_pending_approvals', 'hearthold_decline'],
  emissary: ['hearthold_whoami', 'hearthold_read_card', 'hearthold_contribute', 'hearthold_invoke', 'hearthold_accept_capability', 'hearthold_delegate_capability', 'hearthold_chain_invoke', 'hearthold_revoke_hop', 'hearthold_held'],
  verifier: ['hearthold_whoami', 'hearthold_read_card', 'hearthold_verify_card'],
};

/** The tool set for a role — `full` gets everything; a focused role gets only its actor's verbs. */
export function toolsForRole(role: HeartholdRole): HeartholdTool[] {
  if (role === 'full') return HEARTHOLD_TOOLS;
  const names = new Set(PROFILES[role]);
  return HEARTHOLD_TOOLS.filter((t) => names.has(t.name));
}
