/**
 * The A2A gateway server — A2A at the edge, CGPR internally.
 *
 * Serves the Agent Card at the well-known URI and a JSON-RPC 2.0 endpoint for `message/send` +
 * `tasks/get`. Inbound: C sends a `DataPart` carrying a `CgprRequestArtifact`; the gateway validates
 * the ticket (expiry + single-use + shape), translates to a neutral internal request, relays to the
 * backend (the Warden's CGPR service), and completes the A2A task with a `CgprGrant` (approve) or
 * `CgprDecision` (deny). It holds no secrets: no keys, no plaintext preferences, and the grant is a
 * transient task artifact evicted after retrieval — never a durable cache.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

import {
  CGPR_EXTENSION_URI,
  type CgprRequestArtifact,
  type CgprGrant,
  type CgprDecision,
} from '@hearthold/cgpr-types';

import { A2A_VERSION, AGENT_CARD_PATH, A2A_RPC_PATH, buildAgentCard } from './agent-card.js';
import type { CgprBackend } from './backend.js';

export interface A2aGatewayOptions {
  port: number;
  host?: string;
  /** The gateway's public base URL — baked into the Agent Card. */
  publicUrl: string;
  backend: CgprBackend;
  onListening?: (port: number) => void;
}

export interface A2aGateway {
  readonly port: number;
  close(): void;
}

interface A2aTask {
  id: string;
  contextId: string;
  kind: 'task';
  status: { state: string; timestamp: string };
  artifacts: unknown[];
  history: unknown[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Validate the ticket shape + lifetime. Returns a discriminated result (expiry is called out). */
function validateTicket(
  ticket: unknown,
): { ok: true } | { ok: false; reason: string; expired?: boolean } {
  if (!isObj(ticket)) return { ok: false, reason: 'missing ticket' };
  if (typeof ticket.ticketId !== 'string') return { ok: false, reason: 'ticket has no ticketId' };
  if (!Array.isArray(ticket.scopes) || ticket.scopes.length === 0) return { ok: false, reason: 'ticket has no scopes' };
  if (typeof ticket.purpose !== 'string') return { ok: false, reason: 'ticket has no purpose' };
  if (ticket.singleUse !== true) return { ok: false, reason: 'ticket must be single-use' };
  const exp = Date.parse(String(ticket.expiresAt));
  if (Number.isNaN(exp) || exp <= Date.now()) return { ok: false, reason: 'ticket expired', expired: true };
  return { ok: true };
}

export function startA2aGateway(opts: A2aGatewayOptions): A2aGateway {
  const host = opts.host ?? '127.0.0.1';
  const tasks = new Map<string, A2aTask>();
  const spentTickets = new Set<string>(); // single-use ticket log (conformance check #3)

  const now = (): string => new Date().toISOString();

  const jsonRes = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'A2A-Version': A2A_VERSION });
    res.end(JSON.stringify(payload));
  };
  const rpcOk = (res: ServerResponse, id: unknown, result: unknown): void =>
    jsonRes(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  const rpcErr = (res: ServerResponse, id: unknown, code: number, message: string): void =>
    jsonRes(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  /** Extract the CgprRequestArtifact from the first DataPart of the message. */
  function extractRequest(params: unknown): CgprRequestArtifact | null {
    if (!isObj(params) || !isObj(params.message)) return null;
    const parts = (params.message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return null;
    const dataPart = parts.find((p) => isObj(p) && p.kind === 'data' && isObj(p.data));
    return dataPart ? ((dataPart as { data: unknown }).data as CgprRequestArtifact) : null;
  }

  async function handleSend(id: unknown, params: unknown, res: ServerResponse): Promise<void> {
    const artifact = extractRequest(params);
    const task: A2aTask = {
      id: randomUUID(),
      contextId: randomUUID(),
      kind: 'task',
      status: { state: 'input-required', timestamp: now() }, // consent pending
      artifacts: [],
      history: [],
    };

    const fail = (message: string, state: 'failed' | 'rejected' = 'rejected'): void => {
      task.status = { state, timestamp: now() };
      tasks.set(task.id, task);
      rpcOk(res, id, task);
    };

    if (!artifact || !isObj(artifact.ticket) || !isObj(artifact.requester)) {
      return fail('request is not a CgprRequestArtifact (need ticket + requester in a DataPart)');
    }
    const ticket = artifact.ticket;
    const check = validateTicket(ticket);
    if (!check.ok) return fail(`ticket rejected: ${check.reason}`, check.expired ? 'failed' : 'rejected');
    if (spentTickets.has(ticket.ticketId)) return fail('ticket already spent (single-use)');

    const requester = artifact.requester as { did?: string; agentCardUrl?: string };
    if (typeof requester.did !== 'string') return fail('requester must present its DID for audience-binding');
    const validForMinutes = typeof artifact.validForMinutes === 'number' ? artifact.validForMinutes : 10;

    spentTickets.add(ticket.ticketId); // burn the ticket the moment it is accepted for processing

    let result;
    try {
      result = await opts.backend.submit({
        audience: requester.did,
        scopes: ticket.scopes,
        purpose: ticket.purpose,
        validForMinutes,
      });
    } catch (e) {
      task.status = { state: 'failed', timestamp: now() };
      tasks.set(task.id, task);
      return rpcErr(res, id, -32000, `backend error: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (result.status === 'granted') {
      const grant: CgprGrant = {
        ticketId: ticket.ticketId,
        credential: result.credential,
        schemaDid: result.schemaDid,
        validUntil: result.validUntil,
        singleUse: true,
      };
      task.artifacts = [{ artifactId: randomUUID(), name: 'cgpr-grant', parts: [{ kind: 'data', data: grant }] }];
    } else {
      const decision: CgprDecision = { ticketId: ticket.ticketId, decision: 'denied' };
      task.artifacts = [{ artifactId: randomUUID(), name: 'cgpr-decision', parts: [{ kind: 'data', data: decision }] }];
    }
    task.status = { state: 'completed', timestamp: now() };
    tasks.set(task.id, task);
    rpcOk(res, id, task);
  }

  function handleGetTask(id: unknown, params: unknown, res: ServerResponse): void {
    const taskId = isObj(params) ? String(params.id ?? '') : '';
    const task = tasks.get(taskId);
    if (!task) return rpcErr(res, id, -32001, `task not found: ${taskId}`);
    rpcOk(res, id, task);
  }

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      // Agent Card (raw JSON, not JSON-RPC).
      if (req.method === 'GET' && url.pathname === AGENT_CARD_PATH) {
        return jsonRes(res, 200, buildAgentCard({ url: opts.publicUrl }));
      }
      if (req.method !== 'POST' || url.pathname !== A2A_RPC_PATH) {
        return jsonRes(res, 404, { error: `no route ${req.method} ${url.pathname}` });
      }
      // Echo activated extensions (A2A-Extensions) so the client sees CGPR was honored.
      const activated = String(req.headers['a2a-extensions'] ?? '');
      if (activated.includes(CGPR_EXTENSION_URI)) res.setHeader('A2A-Extensions', CGPR_EXTENSION_URI);

      let rpc: unknown;
      try {
        rpc = await readBody(req);
      } catch {
        return rpcErr(res, null, -32700, 'parse error');
      }
      if (!isObj(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
        return rpcErr(res, isObj(rpc) ? rpc.id : null, -32600, 'invalid JSON-RPC request');
      }
      const { id, method, params } = rpc as { id: unknown; method: string; params: unknown };
      if (method === 'message/send') return void handleSend(id, params, res);
      if (method === 'tasks/get') return handleGetTask(id, params, res);
      return rpcErr(res, id, -32601, `method not found: ${method}`);
    })();
  });

  server.listen(opts.port, host, () =>
    opts.onListening?.(opts.port) ??
    process.stdout.write(
      `A2A gateway on http://${host}:${opts.port}\n` +
        `  agent card:  ${opts.publicUrl}${AGENT_CARD_PATH}\n` +
        `  rpc:         ${opts.publicUrl}${A2A_RPC_PATH}  (A2A ${A2A_VERSION}, CGPR ${CGPR_EXTENSION_URI})\n`,
    ),
  );

  return {
    port: opts.port,
    close: () => server.close(),
  };
}
