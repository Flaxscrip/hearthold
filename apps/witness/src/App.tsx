import { useCallback, useEffect, useState } from 'react';
import type {
  ControlEvent,
  WitnessSnapshot,
  ReceiptRecord,
  ProjectionRecord,
  ProofRecord,
} from '@hearthold/control-types';

import { api, useEvents } from './api';
import { Card, Pill, SensitivityChip, DidTag, Empty } from './ui';

const KINDS = ['event', 'location', 'activity', 'browsing', 'document'] as const;

export function App() {
  const [snap, setSnap] = useState<WitnessSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const mergeReceipt = useCallback((r: ReceiptRecord) => {
    setSnap((s) => {
      if (!s) return s;
      const rest = s.receipts.filter((x) => x.id !== r.id);
      return { ...s, receipts: [r, ...rest] };
    });
  }, []);

  const mergeProof = useCallback((p: ProofRecord) => {
    setSnap((s) => {
      if (!s) return s;
      const rest = s.proofs.filter((x) => x.id !== p.id);
      return { ...s, proofs: [p, ...rest] };
    });
  }, []);

  const onEvent = useCallback(
    (e: ControlEvent) => {
      if (e.type === 'receipt') mergeReceipt((e.data as { receipt: ReceiptRecord }).receipt);
      else if (e.type === 'proof') mergeProof((e.data as { proof: ProofRecord }).proof);
      else if (e.type === 'projection')
        setSnap((s) =>
          s ? { ...s, projections: [(e.data as { projection: ProjectionRecord }).projection, ...s.projections] } : s,
        );
    },
    [mergeReceipt, mergeProof],
  );
  useEvents(onEvent);

  return (
    <div className="app witness">
      <TopBar snap={snap} error={error} />
      <main className="grid">
        <div className="col">
          <SubmitPanel onReceipt={mergeReceipt} />
          <ProvePanel onProof={mergeProof} sovereignSet={Boolean(snap?.status.sovereignDid)} />
        </div>
        <div className="col">
          <ProofsPanel proofs={snap?.proofs ?? []} />
          <ReceiptsPanel receipts={snap?.receipts ?? []} />
          <ProjectionsPanel projections={snap?.projections ?? []} active={Boolean(snap?.status.sovereignDid)} />
        </div>
      </main>
    </div>
  );
}

function TopBar({ snap, error }: { snap: WitnessSnapshot | null; error: string | null }) {
  const s = snap?.status;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="sigil">🧭</span>
        <div>
          <h1>Witness</h1>
          <p className="sub">the Companion · sees in, projects out — holds no secret</p>
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
          <span>warden {s.wardenDid ? <DidTag did={s.wardenDid} /> : <em className="unset">unset</em>}</span>
          <span>sovereign {s.sovereignDid ? <DidTag did={s.sovereignDid} /> : <em className="unset">unset</em>}</span>
        </div>
      )}
      {error && (
        <div className="statline err">
          can’t reach the Witness daemon at <code>{api.base}</code> — run <code>witness control</code>. ({error})
        </div>
      )}
    </header>
  );
}

function SubmitPanel({ onReceipt }: { onReceipt: (r: ReceiptRecord) => void }) {
  const [kind, setKind] = useState<string>('document');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const { receipt } = await api.submit(kind, text.trim());
      onReceipt(receipt);
      setText('');
      setMsg('✦ sealed & sent — awaiting the Warden’s receipt');
      window.setTimeout(() => setMsg(null), 3000);
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Witness an observation">
      <div className="form col2">
        <div className="kinds">
          {KINDS.map((k) => (
            <button
              key={k}
              className={`kindpick${kind === k ? ' on' : ''}`}
              onClick={() => setKind(k)}
              type="button"
            >
              {k}
            </button>
          ))}
        </div>
        <textarea
          placeholder="What did you witness? It is sealed to the Warden’s key here — the relay never sees the content."
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
        <button onClick={submit} disabled={busy || !text.trim()}>
          {busy ? 'sealing…' : `Seal & submit ${kind}`}
        </button>
      </div>
      {msg && <p className="note">{msg}</p>}
    </Card>
  );
}

function ProvePanel({ onProof, sovereignSet }: { onProof: (p: ProofRecord) => void; sovereignSet: boolean }) {
  const [claim, setClaim] = useState('Resided in FR during 2026-H1');
  const [kind, setKind] = useState<string>('location');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const request = async () => {
    if (!claim.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const { proof } = await api.prove(claim.trim(), kind, from || undefined, to || undefined);
      onProof(proof);
      setMsg('✦ requested — the Warden is assembling the evidence graph');
      window.setTimeout(() => setMsg(null), 3200);
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Prove a claim">
      <div className="form col2">
        <input
          className="claimin"
          placeholder="Claim to prove, e.g. “Resided in FR during 2026-H1”"
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
        />
        <div className="kinds">
          {KINDS.map((k) => (
            <button key={k} className={`kindpick${kind === k ? ' on' : ''}`} onClick={() => setKind(k)} type="button">
              {k}
            </button>
          ))}
        </div>
        <div className="daterow">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="from (optional)" />
          <span className="dash">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="to (optional)" />
        </div>
        <button onClick={request} disabled={busy || !claim.trim()}>
          {busy ? 'requesting…' : `Prove from ${kind} data`}
        </button>
      </div>
      <p className="note dim">
        The Warden assembles the matching {kind} observations into a signed evidence graph.
        {sovereignSet
          ? ' A sensitive claim waits for your approval in the Signet.'
          : ' Set HEARTHOLD_SOVEREIGN_DID on the Warden for sensitive claims.'}
      </p>
      {msg && <p className="note">{msg}</p>}
    </Card>
  );
}

function ProofsPanel({ proofs }: { proofs: ProofRecord[] }) {
  const label: Record<ProofRecord['status'], string> = {
    requesting: 'requesting…',
    granted: '✓ granted',
    denied: '✗ denied',
    'step-up-required': 'awaiting approval',
  };
  return (
    <Card title="Proofs" right={<span className="count">{proofs.length}</span>}>
      {proofs.length === 0 ? (
        <Empty>No claims proven yet. Ask the Warden to prove a claim above — a sensitive one lights up the Signet.</Empty>
      ) : (
        <ul className="rows">
          {proofs.map((p) => (
            <li key={p.id} className="row proof">
              <span className={`chip proof-${p.status}`}>{label[p.status]}</span>
              <span className="claimtext" title={p.claim}>{p.claim}</span>
              {p.credentialDid ? (
                <DidTag did={p.credentialDid} />
              ) : (
                p.reason && <span className="reason" title={p.reason}>{p.reason}</span>
              )}
              <span className="when">{new Date(p.at).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReceiptsPanel({ receipts }: { receipts: ReceiptRecord[] }) {
  return (
    <Card title="Receipts" right={<span className="count">{receipts.length}</span>}>
      {receipts.length === 0 ? (
        <Empty>No submissions yet. Witness something above — the Warden’s receipt returns here.</Empty>
      ) : (
        <ul className="rows">
          {receipts.map((r) => (
            <li key={r.id} className="row">
              {r.sensitivityName ? (
                <SensitivityChip name={r.sensitivityName} />
              ) : (
                <span className="chip pending">{r.status}</span>
              )}
              <span className="kind">{r.kind}</span>
              {r.sensitivityName && <span className="stored">stored</span>}
              <span className="when">{new Date(r.at).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ProjectionsPanel({ projections, active }: { projections: ProjectionRecord[]; active: boolean }) {
  return (
    <Card title="Projections" right={<span className="count">{projections.length}</span>}>
      {!active && (
        <p className="note dim">
          Projector idle — set <code>HEARTHOLD_SOVEREIGN_DID</code> on the daemon to relay verifier
          proof-requests to the Signet.
        </p>
      )}
      {projections.length === 0 ? (
        <Empty>No proofs carried yet. When a verifier asks, the request is relayed to the Signet and the outcome shows here.</Empty>
      ) : (
        <ul className="rows">
          {projections.map((p) => (
            <li key={p.id} className="row">
              <span className={`chip out-${p.outcome}`}>{p.outcome}</span>
              <DidTag did={p.requester} />
              {p.humanProof !== undefined && (
                <span className="poh">{p.humanProof ? 'proof-of-human ✓' : 'standing'}</span>
              )}
              <span className="when">{new Date(p.at).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
