import { useEffect, useRef } from 'react';
import type {
  ApiResult,
  ControlEvent,
  SignetSnapshot,
  ApprovalDecisionResponse,
} from '@hearthold/control-types';

const BASE = (import.meta.env.VITE_CONTROL_URL as string | undefined) ?? 'http://127.0.0.1:4311';

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
  snapshot: () => get<SignetSnapshot>('/api/snapshot'),
  decide: (id: string, approve: boolean, pin?: string) =>
    post<ApprovalDecisionResponse>('/api/approve', { id, approve, pin }),
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
