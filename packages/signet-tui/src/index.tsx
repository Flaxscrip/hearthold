/**
 * Signet TUI — the terminal port of `apps/signet-approver`, for contained demos where no web UI is
 * exposed to the host. An Ink (React-for-the-terminal) front-end over the Sovereign's control API
 * (`sovereign control`, default http://127.0.0.1:4311) — the SAME contract the browser app uses
 * (@hearthold/control-types, GET /api/snapshot, POST /api/approve). Reuses the "brains"; swaps only
 * the render layer (DOM → terminal). Run inside the sovereign container over `docker compose exec -it`.
 *
 * Option (a): a client of the localhost control plane — nothing is published to the host.
 */
import { render, Box, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import type { SignetSnapshot, PendingApproval } from '@hearthold/control-types';

const BASE = process.env.HEARTHOLD_CONTROL_URL ?? 'http://127.0.0.1:4311';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init);
  const body = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (body.ok === false) throw new Error(body.error ?? `request to ${path} failed`);
  return body;
}
const getSnapshot = () => call<SignetSnapshot>('/api/snapshot');
const decide = (id: string, approve: boolean, pin?: string) =>
  call<{ id: string; decision: string }>('/api/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, approve, pin }),
  });

/** The Warden-authored, human-readable line for a pending disclosure (never the requester's own words). */
function summarize(p: PendingApproval): string {
  switch (p.kind) {
    case 'proof-request':
      return `present a held credential${p.schema ? ` (schema ${p.schema.slice(0, 16)}…)` : ''}`;
    case 'evidence-approval':
      return `co-sign: “${p.claim ?? ''}”${p.reason ? ` — ${p.reason}` : ''}`;
    case 'kb-action':
      return `authorize ${p.action ?? 'action'} on ${p.resource ?? '?'}${p.summary ? `: ${p.summary}` : ''}`;
    case 'policy-signature':
      return `sign policy change${p.summary ? `: ${p.summary}` : ''}`;
    default:
      return p.kind;
  }
}

function App(): JSX.Element {
  const { exit } = useApp();
  const [snap, setSnap] = useState<SignetSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<'list' | 'pin'>('list');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSnap(await getSnapshot());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const pending = snap?.pending ?? [];
  useEffect(() => {
    if (sel > 0 && sel >= pending.length) setSel(Math.max(0, pending.length - 1));
  }, [pending.length, sel]);

  const resolve = useCallback(
    (target: PendingApproval, approve: boolean, enteredPin?: string) => {
      decide(target.id, approve, enteredPin)
        .then((r) => {
          setMsg(`${target.kind} → ${r.decision}`);
          void refresh();
        })
        .catch((e) => setMsg(`error: ${e instanceof Error ? e.message : String(e)}`));
    },
    [refresh],
  );

  useInput(
    (input, key) => {
      if (mode === 'pin') {
        const target = pending[sel];
        if (key.escape) {
          setMode('list');
          setPin('');
        } else if (key.return) {
          setMode('list');
          const entered = pin;
          setPin('');
          if (target) resolve(target, true, entered);
        } else if (key.backspace || key.delete) {
          setPin((s) => s.slice(0, -1));
        } else if (input && input.length === 1 && !key.ctrl && !key.meta) {
          setPin((s) => s + input);
        }
        return;
      }
      // list mode
      if (input === 'q' || (key.ctrl && input === 'c')) return exit();
      if (key.upArrow || input === 'k') setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === 'j') setSel((s) => Math.min(Math.max(0, pending.length - 1), s + 1));
      else if (input === 'a' && pending[sel]) {
        setPin('');
        setMsg('');
        setMode('pin');
      } else if (input === 'd' && pending[sel]) {
        resolve(pending[sel] as PendingApproval, false);
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  const st = snap?.status;
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text bold color="cyan">🔑 Hearthold Signet  </Text>
        <Text dimColor>
          {st ? `${st.identity.did.slice(0, 30)}…  ·  node ${st.nodeUrl}  ·  serving ${st.serving ? '✓' : '✗'}` : 'connecting…'}
        </Text>
      </Box>
      {err ? (
        <Text color="red">
          can’t reach the Signet daemon at {BASE} — run `sovereign control` first  ({err})
        </Text>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Pending approvals ({pending.length})</Text>
        {pending.length === 0 ? (
          <Text dimColor> (none — waiting for a disclosure to arrive…)</Text>
        ) : (
          pending.map((p, i) => (
            <Text key={p.id} color={i === sel ? 'green' : undefined}>
              {i === sel ? '❯ ' : '  '}
              [{p.kind}] from {p.requester.slice(0, 22)}…  —  {summarize(p)}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        {mode === 'pin' ? (
          <Text>
            Enter Signet PIN to approve: <Text color="yellow">{'*'.repeat(pin.length)}</Text>
            <Text dimColor>   (Enter = approve · Esc = cancel)</Text>
          </Text>
        ) : (
          <Text dimColor>↑/↓ select · a approve · d deny · q quit</Text>
        )}
      </Box>
      {msg ? (
        <Box marginTop={1}>
          <Text color="magenta">{msg}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

render(<App />);
