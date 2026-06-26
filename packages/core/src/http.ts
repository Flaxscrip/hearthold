/**
 * HTTP layer shared by Witness and Warden. The Warden serves these paths bound to a private
 * (Tailscale) interface; the Witness reaches them at a configured base URL. No notices, no
 * registry footprint — just a direct authenticated channel between two nodes the Sovereign owns.
 */

/** Canonical endpoint paths. */
export const HttpPaths = {
  health: '/health',
  sessionChallenge: '/session/challenge',
  session: '/session',
  submit: '/submit',
  evidence: '/evidence',
} as const;

export interface HealthInfo {
  wardenDid: string;
  version: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const reason =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : res.statusText;
    throw new HttpError(res.status, reason);
  }
  return body as T;
}

export async function getJson<T>(url: string, token?: string): Promise<T> {
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return parse<T>(res);
}

export async function postJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return parse<T>(res);
}
