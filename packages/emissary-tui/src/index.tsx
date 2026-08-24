/**
 * Emissary TUI — the terminal port of `apps/emissary`, for contained demos where no web UI is exposed
 * to the host. An Ink (React-for-the-terminal) front-end over the Emissary's control API
 * (`emissary control`, default http://127.0.0.1:4312) — the SAME contract the browser app uses
 * (@hearthold/control-types, GET /api/snapshot, POST /api/submit). Reuses the "brains"; only the render
 * layer differs. Run inside the emissary container over `docker compose exec -it`.
 *
 * Companion to packages/signet-tui — same Ink shell, pointed at the Emissary's control plane.
 */
import { render, Box, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import type { EmissarySnapshot, ReceiptRecord } from '@hearthold/control-types';

const BASE = process.env.HEARTHOLD_CONTROL_URL ?? 'http://127.0.0.1:4312';
const KINDS = ['event', 'location', 'activity', 'browsing', 'document'] as const;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init);
  const body = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (body.ok === false) throw new Error(body.error ?? `request to ${path} failed`);
  return body;
}
const getSnapshot = () => call<EmissarySnapshot>('/api/snapshot');
const submit = (kind: string, text: string) =>
  call<{ receipt: { id: string; status: string } }>('/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, text }),
  });

function App(): JSX.Element {
  const { exit } = useApp();
  const [snap, setSnap] = useState<EmissarySnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'browse' | 'kind' | 'text'>('browse');
  const [kindIdx, setKindIdx] = useState(0);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  // The Emissary's `receipts` list only fills once the Warden replies STORED (and classification is
  // slow). Keep provisional receipts locally so a submit shows in the list instantly, then let the
  // snapshot's STORED record (same id, with its sensitivity) overwrite it.
  const [local, setLocal] = useState<ReceiptRecord[]>([]);

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

  const doSubmit = useCallback(
    (kind: string, body: string) => {
      submit(kind, body)
        .then((r) => {
          setMsg(`submitted ${kind} → receipt ${r.receipt.id.slice(0, 12)}… (${r.receipt.status})`);
          setLocal((prev) => [{ id: r.receipt.id, kind, status: r.receipt.status, at: new Date().toISOString() }, ...prev].slice(0, 20));
          void refresh();
        })
        .catch((e) => setMsg(`error: ${e instanceof Error ? e.message : String(e)}`));
    },
    [refresh],
  );

  useInput(
    (input, key) => {
      if (mode === 'text') {
        const kind = KINDS[kindIdx] ?? KINDS[0];
        if (key.escape) {
          setMode('browse');
          setText('');
        } else if (key.return) {
          const body = text;
          setMode('browse');
          setText('');
          if (body.trim()) doSubmit(kind, body);
        } else if (key.backspace || key.delete) {
          setText((s) => s.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setText((s) => s + input);
        }
        return;
      }
      if (mode === 'kind') {
        if (key.escape) setMode('browse');
        else if (key.upArrow || input === 'k') setKindIdx((i) => Math.max(0, i - 1));
        else if (key.downArrow || input === 'j') setKindIdx((i) => Math.min(KINDS.length - 1, i + 1));
        else if (key.return) {
          setText('');
          setMode('text');
        }
        return;
      }
      // browse
      if (input === 'q' || (key.ctrl && input === 'c')) return exit();
      if (input === 's') {
        setMsg('');
        setMode('kind');
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  const st = snap?.status;
  // Merge local provisional receipts with the snapshot's; the snapshot's STORED record (same id) wins.
  const receipts = (() => {
    const byId = new Map<string, ReceiptRecord>();
    for (const r of local) byId.set(r.id, r);
    for (const r of snap?.receipts ?? []) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
  })();
  const activeKind = KINDS[kindIdx] ?? KINDS[0];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">📡 Hearthold Emissary  </Text>
        <Text dimColor>
          {st
            ? `${st.identity.did.slice(0, 28)}…  ·  node ${st.nodeUrl}  ·  warden ${(st.wardenDid ?? '— not set').slice(0, 16)}…`
            : 'connecting…'}
        </Text>
      </Box>
      {err ? (
        <Text color="red">
          can’t reach the Emissary daemon at {BASE} — run `emissary control` first  ({err})
        </Text>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Recent submissions ({receipts.length})</Text>
        {receipts.length === 0 ? (
          <Text dimColor> (none yet — press ‘s’ to submit an observation to the Warden)</Text>
        ) : (
          receipts.slice(0, 8).map((r) => (
            <Text key={r.id}>
              {'  '}
              [<Text color="yellow">{r.sensitivityName ?? '·····'}</Text>] {r.kind} · {r.status} ·{' '}
              {r.at.slice(11, 19)} · {r.id.slice(0, 10)}…
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {mode === 'kind' ? (
          <Box flexDirection="column">
            <Text>Observation kind:</Text>
            {KINDS.map((k, i) => (
              <Text key={k} color={i === kindIdx ? 'green' : undefined}>
                {i === kindIdx ? '❯ ' : '  '}
                {k}
              </Text>
            ))}
            <Text dimColor>↑/↓ select · Enter next · Esc cancel</Text>
          </Box>
        ) : mode === 'text' ? (
          <Text>
            {activeKind} → <Text color="yellow">{text}</Text>
            <Text dimColor>▌  (Enter = submit · Esc = cancel)</Text>
          </Text>
        ) : (
          <Text dimColor>s submit observation · q quit</Text>
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
