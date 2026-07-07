import { useCallback, useEffect, useState } from 'react';
import type {
  ControlEvent,
  SignetSnapshot,
  PendingApproval,
  ApprovalHistoryEntry,
} from '@hearthold/control-types';

import { api, useEvents } from './api';
import { Card, Pill, DidTag, Empty } from './ui';

export function App() {
  const [snap, setSnap] = useState<SignetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chime, setChime] = useState(false);

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

  const onEvent = useCallback(
    (e: ControlEvent) => {
      if (e.type === 'approval-pending') {
        setChime(true);
        window.setTimeout(() => setChime(false), 1500);
      }
      if (e.type.startsWith('approval-')) void refresh();
    },
    [refresh],
  );
  useEvents(onEvent);

  const pending = snap?.pending ?? [];
  return (
    <div className={`app signet${chime ? ' chime' : ''}`}>
      <TopBar snap={snap} error={error} />
      <main className="stack">
        <Card
          title="Awaiting your approval"
          right={<span className={`count${pending.length ? ' count-hot' : ''}`}>{pending.length}</span>}
        >
          {pending.length === 0 ? (
            <Empty>
              Nothing to approve. When a verifier requests a disclosure, it appears here — presenting a
              proof <em>is</em> the disclosure, so nothing leaves without your assent.
            </Empty>
          ) : (
            <div className="approvals">
              {pending.map((p) => (
                <ApprovalCard key={p.id} approval={p} onResolved={refresh} />
              ))}
            </div>
          )}
        </Card>
        <HistoryPanel history={snap?.history ?? []} />
      </main>
    </div>
  );
}

function TopBar({ snap, error }: { snap: SignetSnapshot | null; error: string | null }) {
  const s = snap?.status;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="sigil">🔑</span>
        <div>
          <h1>Signet</h1>
          <p className="sub">the Sovereign’s seal · proof-of-human before any disclosure</p>
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
      </div>
      {s && (
        <div className="statline">
          <span>node <code>{s.nodeUrl}</code></span>
          <span>{s.pendingCount} awaiting</span>
        </div>
      )}
      {error && (
        <div className="statline err">
          can’t reach the Signet daemon at <code>{api.base}</code> — run <code>sovereign control</code>. ({error})
        </div>
      )}
    </header>
  );
}

function ApprovalCard({ approval, onResolved }: { approval: PendingApproval; onResolved: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api.decide(approval.id, approve, pin);
      onResolved();
    } catch (e) {
      // Wrong PIN keeps the request pending — surface it and let them retry.
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const isEvidence = approval.kind === 'evidence-approval';
  const isAction = approval.kind === 'kb-action';
  const label = isEvidence ? 'evidence disclosure' : isAction ? 'action authorization' : 'disclosure request';
  return (
    <div className={`approval${isEvidence ? ' evidence' : ''}${isAction ? ' action' : ''}`}>
      <div className="approval-head">
        <span className="req-label">{label}</span>
        <span className="ago">{new Date(approval.receivedAt).toLocaleTimeString()}</span>
      </div>
      {isAction ? (
        <dl className="ctx">
          <dt>authorize</dt>
          <dd className="claim">
            <span className="chip">{approval.action}</span> on <code>{approval.resource}</code>
          </dd>
          {approval.summary && (
            <>
              <dt>detail</dt>
              <dd className="reason">{approval.summary}</dd>
            </>
          )}
          <dt>from Warden</dt>
          <dd><DidTag did={approval.requester} /></dd>
        </dl>
      ) : isEvidence ? (
        <dl className="ctx">
          <dt>claim</dt>
          <dd className="claim">{approval.claim}</dd>
          {approval.reason && (
            <>
              <dt>reason</dt>
              <dd className="reason">{approval.reason}</dd>
            </>
          )}
          <dt>from Warden</dt>
          <dd><DidTag did={approval.requester} /></dd>
        </dl>
      ) : (
        <dl className="ctx">
          <dt>from</dt>
          <dd><DidTag did={approval.requester} /></dd>
          {approval.schema && (
            <>
              <dt>schema</dt>
              <dd><DidTag did={approval.schema} /></dd>
            </>
          )}
          {approval.challengeDid && (
            <>
              <dt>challenge</dt>
              <dd><DidTag did={approval.challengeDid} /></dd>
            </>
          )}
          {approval.sensitivityName && (
            <>
              <dt>sensitivity</dt>
              <dd><span className="chip">{approval.sensitivityName}</span></dd>
            </>
          )}
        </dl>
      )}
      <div className="approval-act">
        <input
          type="password"
          inputMode="numeric"
          placeholder="Signet PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pin) void decide(true);
          }}
          disabled={busy}
          autoFocus
        />
        <button className="approve" onClick={() => void decide(true)} disabled={busy || !pin}>
          {busy ? '…' : 'Approve'}
        </button>
        <button className="deny" onClick={() => void decide(false)} disabled={busy}>
          Deny
        </button>
      </div>
      {err && <p className="approval-err">✗ {err}</p>}
    </div>
  );
}

function HistoryPanel({ history }: { history: ApprovalHistoryEntry[] }) {
  return (
    <Card title="Recent decisions" right={<span className="count">{history.length}</span>}>
      {history.length === 0 ? (
        <Empty>No decisions yet.</Empty>
      ) : (
        <ul className="rows">
          {history.map((h) => (
            <li key={h.id} className="row">
              <span className={`chip ${h.decision === 'approved' ? 'ok' : 'no'}`}>
                {h.decision === 'approved' ? '✓ approved' : '✗ denied'}
              </span>
              <DidTag did={h.requester} />
              {h.method && <span className="method">{h.method} · L{h.level}</span>}
              <span className="when">{new Date(h.at).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
