import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import {
  HttpPaths,
  AuthzTier,
  createDelegationChallenge,
  verifyChallengeResponse,
  ensureDelegationSchema,
  currentIdentity,
  type KeymasterHandle,
  type WitnessSubmission,
  type EvidenceRequest,
  type EvidenceResponse,
  type SessionGrant,
} from '@hearthold/core';

import { WardenService } from './service.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const WARDEN_VERSION = '0.2.0';

interface Session {
  witnessDid: string;
  tier: AuthzTier;
  expiresAt: number;
}

/** In-memory session store. Tokens are bearer credentials scoped to a Witness DID + tier. */
class SessionManager {
  private readonly sessions = new Map<string, Session>();

  open(witnessDid: string, tier: AuthzTier): SessionGrant {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { witnessDid, tier, expiresAt });
    return { token, tier, expiresAt: new Date(expiresAt).toISOString() };
  }

  get(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return s;
  }
}

/**
 * The Warden's HTTP service. Bind it to a private (Tailscale) interface — the Witness opens a
 * session via the delegation challenge/response, then submits sealed observations. Sensitive
 * evidence requests trigger per-request step-up (handled in the evidence flow, next milestone).
 */
export class WardenServer {
  private readonly service: WardenService;
  private readonly sessions = new SessionManager();
  private server?: Server;
  private wardenDid = '';
  private schemaDid = '';

  constructor(private readonly warden: KeymasterHandle) {
    this.service = new WardenService(warden);
  }

  async listen(bindAddr: string, port: number): Promise<{ addr: string; port: number }> {
    const id = await currentIdentity(this.warden);
    if (!id) throw new Error('warden has no current identity — run `warden init` first');
    this.wardenDid = id.did;
    this.schemaDid = await ensureDelegationSchema(this.warden);

    this.server = createServer((req, res) => {
      this.route(req, res).catch((err: unknown) => {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(port, bindAddr, resolve));
    const address = this.server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    return { addr: bindAddr, port: boundPort };
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (method === 'GET' && url === HttpPaths.health) {
      return send(res, 200, { wardenDid: this.wardenDid, version: WARDEN_VERSION });
    }

    if (method === 'POST' && url === HttpPaths.sessionChallenge) {
      const challengeDid = await createDelegationChallenge(this.warden, this.schemaDid);
      return send(res, 200, { challengeDid });
    }

    if (method === 'POST' && url === HttpPaths.session) {
      const { responseDid } = await readJson<{ responseDid: string }>(req);
      const verdict = await verifyChallengeResponse(this.warden, responseDid);
      if (!verdict.verified || !verdict.responderDid) {
        return send(res, 401, { error: 'challenge response did not verify' });
      }
      // A verified delegation establishes the baseline STANDING tier.
      return send(res, 200, this.sessions.open(verdict.responderDid, AuthzTier.STANDING));
    }

    // ── Authenticated routes ──
    const session = this.sessions.get(bearer(req));
    if (!session) return send(res, 401, { error: 'missing or expired session' });

    if (method === 'POST' && url === HttpPaths.submit) {
      const submission = await readJson<WitnessSubmission>(req);
      const receipt = await this.service.handleSubmission(submission, session.witnessDid);
      return send(res, 200, receipt);
    }

    if (method === 'POST' && url === HttpPaths.evidence) {
      const request = await readJson<EvidenceRequest>(req);
      return send(res, 200, this.evidenceStub(request));
    }

    send(res, 404, { error: `no route for ${method} ${url}` });
  }

  /** Placeholder evidence handler — full retrieval + step-up minting is the next milestone. */
  private evidenceStub(request: EvidenceRequest): EvidenceResponse {
    return {
      type: 'hearthold/evidence-response',
      version: request.version,
      status: 'denied',
      reason: 'evidence + step-up flow is the next milestone',
    };
  }
}

// ── small http helpers ──

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as T;
}
