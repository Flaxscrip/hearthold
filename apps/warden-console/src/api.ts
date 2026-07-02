import { useEffect, useRef } from 'react';
import type {
  ApiResult,
  ControlEvent,
  WardenSnapshot,
  DelegateResponse,
  ClassifyResponse,
} from '@hearthold/control-types';

const BASE = (import.meta.env.VITE_CONTROL_URL as string | undefined) ?? 'http://127.0.0.1:4310';

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
  snapshot: () => get<WardenSnapshot>('/api/snapshot'),
  delegate: (witnessDid: string) => post<DelegateResponse>('/api/delegate', { witnessDid }),
  classify: (kind: string, text: string) => post<ClassifyResponse>('/api/classify', { kind, text }),
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
