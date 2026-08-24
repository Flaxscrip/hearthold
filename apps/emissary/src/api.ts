import { useEffect, useRef } from 'react';
import type {
  ApiResult,
  ControlEvent,
  EmissarySnapshot,
  SubmitResponse,
  InvokeRequest,
  InvokeResponse,
} from '@hearthold/control-types';

const BASE = (import.meta.env.VITE_CONTROL_URL as string | undefined) ?? 'http://127.0.0.1:4312';

function unwrap<T>(r: ApiResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  const { ok: _ok, ...rest } = r;
  return rest as unknown as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  return unwrap<T>((await res.json()) as ApiResult<T>);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return unwrap<T>((await res.json()) as ApiResult<T>);
}

export const api = {
  base: BASE,
  snapshot: () => get<EmissarySnapshot>('/api/snapshot'),
  submit: (kind: string, text: string) => post<SubmitResponse>('/api/submit', { kind, text }),
  // Forge: the daemon runs the full invocation ceremony with its own wallet + scope capability and blocks
  // while the Warden gets the owner's consent for a sensitive claim. Returns granted | denied verbatim.
  invoke: (req: InvokeRequest) => post<InvokeResponse>('/api/invoke', req),
};

/** Subscribe to the daemon's SSE event stream; `onEvent` fires per pushed event. */
export function useEvents(onEvent: (e: ControlEvent) => void): void {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const es = new EventSource(`${BASE}/api/events`);
    es.onmessage = (m: MessageEvent<string>) => {
      try {
        cb.current(JSON.parse(m.data) as ControlEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }, []);
}
