/**
 * The portal's HTTP client to the public Emissary (`emissary kb-web`). The Emissary relays over DIDComm to the
 * private Warden. Login is challenge/response: start (get a challenge), poll (until the wallet responds
 * and the Warden mints a session), then ride the session on each op. No keys in the browser.
 */

const PORTAL_URL = (import.meta.env.VITE_PORTAL_URL as string | undefined) ?? 'http://127.0.0.1:4313';

interface ApiOk {
  ok: true;
  [k: string]: unknown;
}
interface ApiErr {
  ok: false;
  error: string;
}

async function call<T>(path: string, method: 'GET' | 'POST', body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${PORTAL_URL}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as ApiOk | ApiErr;
  if (!json.ok) throw new Error(json.error);
  const { ok: _ok, ...rest } = json;
  return rest as unknown as T;
}

export interface Session {
  token: string;
  did: string;
  expiresAt: string;
  /** KB Spaces: this KB grants each member a private partition (show a shared/private toggle). */
  memberPartitions?: boolean;
  /** The toggle's default when the member doesn't pick. */
  defaultScope?: 'shared' | 'private';
}

export interface KbCitation {
  artefactId: string;
  kind: string;
  observedAt: string;
  score: number;
  /** Which partition this citation came from — shown as a badge. */
  scope?: 'shared' | 'private';
  /** Public locus of the cited passage (book corpora) — a where-to-look, not the sealed text. */
  volume?: string;
  chapter?: string;
  section?: string;
  /** A link to the public source passage, when the corpus is public. */
  url?: string;
}

/** The Warden's reply, relayed verbatim by the Mage. */
export type KbResult =
  | { type: 'hearthold/kb-result'; action: 'query'; answer: string; citations: KbCitation[] }
  | { type: 'hearthold/kb-result'; action: 'update'; artefactId: string; scope: 'shared' | 'private' }
  | { type: 'hearthold/kb-error'; reason: string };

export interface SessionRequestBody {
  token: string;
  kbId: string;
  action: 'query' | 'update';
  query?: string;
  k?: number;
  kind?: string;
  text?: string;
  /** KB Spaces: contribute to the shared partition or the member's own private one. */
  scope?: 'shared' | 'private';
}

export const portalApi = {
  url: PORTAL_URL,
  /** Anonymous (no-wallet) public query — answered by the portal's read-only oracle reader over the
   *  shared chronicle. Available only when the Emissary has an oracle configured. */
  ask: (kbId: string, query: string, k?: number) =>
    call<{ answer: string; citations: KbCitation[] }>('/api/kb/ask', 'POST', { kbId, query, k }),
  // start returns a pollSecret that stays in the SPA (never in the challenge document); poll must present it,
  // so a party reading the loginId off the public gossip network can't claim the session.
  loginStart: (kbId: string) =>
    call<{ loginId: string; challenge: string; pollSecret: string }>('/api/kb/login/start', 'POST', { kbId }),
  loginPoll: (loginId: string, pollSecret: string) =>
    // The secret rides in a HEADER, never the query string — a query param would land in nginx access logs,
    // Referer, and browser history, which is exactly where a secret must not be.
    call<{ status: 'pending' | 'ready' | 'unknown'; session?: Session }>(
      `/api/kb/login/poll?login=${encodeURIComponent(loginId)}`,
      'GET',
      undefined,
      { 'X-Hearthold-Poll-Secret': pollSecret },
    ),
  sessionRequest: (body: SessionRequestBody) => call<{ result: KbResult }>('/api/kb/session-request', 'POST', body),
};
