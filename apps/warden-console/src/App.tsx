import { useCallback, useEffect, useState } from 'react';
import type {
  ControlEvent,
  WardenSnapshot,
  VaultItem,
  SubmissionStoredEvent,
} from '@hearthold/control-types';

import { api, useEvents } from './api';
import { Card, Pill, SensitivityChip, DidTag, Empty } from './ui';

export function App() {
  const [snap, setSnap] = useState<WardenSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnap(await api.snapshot());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onEvent = useCallback((e: ControlEvent) => {
    if (e.type === 'submission-stored') {
      const { item } = e.data as SubmissionStoredEvent;
      setSnap((s) =>
        s
          ? { ...s, vault: [item, ...s.vault.filter((v) => v.id !== item.id)],
              status: { ...s.status, artefactCount: s.status.artefactCount + 1 } }
          : s,
      );
      setFlash(`new ${item.kind} · ${item.sensitivityName}`);
      window.setTimeout(() => setFlash(null), 2600);
    } else if (e.type === 'delegation-issued') {
      void refresh();
    }
  }, [refresh]);
  useEvents(onEvent);

  return (
    <div className="app warden">
      <TopBar snap={snap} error={error} flash={flash} />
      <main className="grid">
        <VaultPanel vault={snap?.vault ?? []} />
        <div className="col">
          <DelegatePanel onDone={refresh} />
          <DelegationsPanel snap={snap} />
          <ClassifyPanel />
        </div>
      </main>
    </div>
  );
}

function TopBar({ snap, error, flash }: { snap: WardenSnapshot | null; error: string | null; flash: string | null }) {
  const s = snap?.status;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="sigil">🛡️</span>
        <div>
          <h1>Warden Console</h1>
          <p className="sub">home Keeper · the sealed vault, made visible</p>
        </div>
      </div>
      <div className="topbar-meta">
        {error ? (
          <Pill tone="off">daemon offline</Pill>
        ) : s ? (
          <Pill tone="live">serving</Pill>
        ) : (
          <Pill tone="warn">connecting…</Pill>
        )}
        {s && <DidTag did={s.identity.did} />}
        {flash && <span className="flash">✦ {flash}</span>}
      </div>
      {s && (
        <div className="statline">
          <span>node <code>{s.nodeUrl}</code></span>
          <span>classifier <code>{s.classifier}</code></span>
          <span>{s.artefactCount} artefact(s)</span>
          <span>{s.delegationCount} delegation(s)</span>
        </div>
      )}
      {error && <div className="statline err">can’t reach the Warden daemon at <code>{api.base}</code> — run <code>warden control</code>. ({error})</div>}
    </header>
  );
}

function VaultPanel({ vault }: { vault: VaultItem[] }) {
  return (
    <Card title="Vault" right={<span className="count">{vault.length}</span>}>
      {vault.length === 0 ? (
        <Empty>No artefacts yet. Submit one from the Witness app — it will appear here live.</Empty>
      ) : (
        <ul className="rows">
          {vault.map((v) => (
            <li key={v.id} className="row">
              <SensitivityChip name={v.sensitivityName} />
              <span className="kind">{v.kind}</span>
              <span className="when">{new Date(v.observedAt).toLocaleString()}</span>
              <DidTag did={v.id} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DelegatePanel({ onDone }: { onDone: () => void }) {
  const [did, setDid] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    if (!did.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.delegate(did.trim());
      setMsg(`✓ delegated — credential ${r.credentialDid.slice(0, 20)}…`);
      setDid('');
      onDone();
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Delegate a Witness">
      <div className="form">
        <input
          placeholder="did:cid:… of the Witness"
          value={did}
          onChange={(e) => setDid(e.target.value)}
          spellCheck={false}
        />
        <button onClick={submit} disabled={busy || !did.trim()}>
          {busy ? 'issuing…' : 'Issue delegation'}
        </button>
      </div>
      {msg && <p className="note">{msg}</p>}
    </Card>
  );
}

function DelegationsPanel({ snap }: { snap: WardenSnapshot | null }) {
  const rows = snap?.delegations ?? [];
  return (
    <Card title="Delegations" right={<span className="count">{rows.length}</span>}>
      {rows.length === 0 ? (
        <Empty>No Witnesses delegated yet.</Empty>
      ) : (
        <ul className="rows">
          {rows.map((d) => (
            <li key={d.credentialDid} className="row">
              <span className="chip sens-low">witness</span>
              <DidTag did={d.subjectDid} />
              <span className="arrow">→</span>
              <DidTag did={d.credentialDid} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ClassifyPanel() {
  const [kind, setKind] = useState('document');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);

  const run = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setOut(null);
    try {
      const r = await api.classify(kind, text.trim());
      setOut(`${r.sensitivityName} — ${r.reason || '(no reason)'}${r.tags.length ? ` · [${r.tags.join(', ')}]` : ''}`);
    } catch (e) {
      setOut(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Classifier — try it">
      <div className="form col2">
        <input className="kindin" value={kind} onChange={(e) => setKind(e.target.value)} />
        <textarea
          placeholder="Paste some text; the local model labels its sensitivity (nothing is stored)."
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
        <button onClick={run} disabled={busy || !text.trim()}>
          {busy ? 'classifying…' : 'Classify'}
        </button>
      </div>
      {out && <p className="note">{out}</p>}
    </Card>
  );
}
