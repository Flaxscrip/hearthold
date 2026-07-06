/**
 * The portal's HTTP client to the public Mage (`witness kb-web`). The Mage relays over DIDComm to the
 * private Warden and returns the result. Two calls mirror the CLI's two DIDComm messages: fetch a
 * nonce, then submit the signed request.
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${PORTAL_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ApiOk | ApiErr;
  if (!json.ok) throw new Error(json.error);
  const { ok: _ok, ...rest } = json;
  return rest as unknown as T;
}

export interface KbCitation {
  artefactId: string;
  kind: string;
  observedAt: string;
  score: number;
}

/** The Warden's reply, relayed verbatim by the Mage. */
export type KbResult =
  | { type: 'hearthold/kb-result'; action: 'query'; answer: string; citations: KbCitation[] }
  | { type: 'hearthold/kb-result'; action: 'update'; artefactId: string }
  | { type: 'hearthold/kb-error'; reason: string };

export const portalApi = {
  url: PORTAL_URL,
  challenge: (kbId: string) => post<{ nonce: string }>('/api/kb/challenge', { kbId }),
  request: (request: unknown) => post<{ result: KbResult }>('/api/kb/request', { request }),
};
