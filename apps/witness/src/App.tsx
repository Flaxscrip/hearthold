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
    // Poll as a safety net so the panels always reflect the daemon even if a live event is missed.
    const t = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(t);
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

/** Derive a structured predicate from the GUI selections (kind + optional window). */
function autoStructured(kind: string, from: string, to: string): string {
  const obj: Record<string, unknown> = { type: kind };
  if (from) obj.from = from;
  if (to) obj.to = to;
  return JSON.stringify(obj);
}

function ProvePanel({ onProof, sovereignSet }: { onProof: (p: ProofRecord) => void; sovereignSet: boolean }) {
  const [claim, setClaim] = useState('');
  const [kind, setKind] = useState<string>('location');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [structured, setStructured] = useState('');
  // Until the user hand-edits the structured field, keep it in sync with the GUI selections.
  const [structuredEdited, setStructuredEdited] = useState(false);
  const [ttl, setTtl] = useState('10');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!structuredEdited) setStructured(autoStructured(kind, from, to));
  }, [kind, from, to, structuredEdited]);

  const request = async () => {
    if (!claim.trim()) return;
    let structuredObj: Record<string, unknown> | undefined;
    if (structured.trim()) {
      try {
        structuredObj = JSON.parse(structured) as Record<string, unknown>;
      } catch {
        setMsg('✗ structured must be valid JSON (or leave it blank)');
        return;
      }
    }
    setBusy(true);
    setMsg(null);
    try {
      const { proof } = await api.prove({
        claim: claim.trim(),
        kind,
        from: from || undefined,
        to: to || undefined,
        structured: structuredObj,
        validForMinutes: ttl ? Number(ttl) : undefined,
      });
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
        <div className="structuredrow">
          <input
            className="claimin"
            placeholder="structured predicate (JSON, optional)"
            value={structured}
            onChange={(e) => {
              setStructured(e.target.value);
              setStructuredEdited(true);
            }}
            spellCheck={false}
          />
          <span className="structuredtag">
            {structuredEdited ? (
              <button
                type="button"
                className="linkbtn"
                onClick={() => {
                  setStructuredEdited(false);
                  setStructured(autoStructured(kind, from, to));
                }}
              >
                reset to auto
              </button>
            ) : (
              'auto ✎'
            )}
          </span>
        </div>
        <label className="ttlrow">
          valid for
          <input className="ttlin" type="number" min={1} value={ttl} onChange={(e) => setTtl(e.target.value)} />
          minutes
        </label>
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

const PROOF_LABEL: Record<ProofRecord['status'], string> = {
  requesting: 'requesting…',
  granted: '✓ granted',
  denied: '✗ denied',
};

function ProofsPanel({ proofs }: { proofs: ProofRecord[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="Proofs" right={<span className="count">{proofs.length}</span>}>
      {proofs.length === 0 ? (
        <Empty>No claims proven yet. Ask the Warden to prove a claim above — a sensitive one lights up the Signet.</Empty>
      ) : (
        <ul className="rows">
          {proofs.map((p) => {
            const expandable = p.status === 'granted';
            const isOpen = open === p.id;
            return (
              <li key={p.id} className="proofitem">
                <div
                  className={`row proof${expandable ? ' clickable' : ''}`}
                  onClick={() => expandable && setOpen(isOpen ? null : p.id)}
                >
                  <span className={`chip proof-${p.status}`}>{PROOF_LABEL[p.status]}</span>
                  <span className="claimtext" title={p.claim}>{p.claim}</span>
                  {p.status !== 'granted' && p.reason && (
                    <span className="reason" title={p.reason}>{p.reason}</span>
                  )}
                  {expandable && <span className="caret">{isOpen ? '▾' : '▸'}</span>}
                  <span className="when">{new Date(p.at).toLocaleTimeString()}</span>
                </div>
                {isOpen && <ProofDetail proof={p} />}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ProofDetail({ proof }: { proof: ProofRecord }) {
  return (
    <div className="proofdetail">
      <dl className="ctx">
        <dt>claim</dt>
        <dd className="claim">{proof.claim}</dd>
        {proof.structured && Object.keys(proof.structured).length > 0 && (
          <>
            <dt>structured</dt>
            <dd><code className="mono">{JSON.stringify(proof.structured)}</code></dd>
          </>
        )}
        {(proof.evidence ?? []).map((g, i) => (
          <ProofGroup key={i} g={g} />
        ))}
        <dt>approval</dt>
        <dd>
          {proof.approved ? (
            <span className="chip proof-granted">Sovereign co-signed (proof-of-human)</span>
          ) : (
            <span className="chip standing">standing — no co-sign needed</span>
          )}
        </dd>
        <dt>trust</dt>
        <dd>
          {proof.trustClass === 'composite' ? (
            <span className="chip proof-granted">composite — witnessed + issued</span>
          ) : (
            <>the Warden · <em>witnessed</em></>
          )}
        </dd>
        {(proof.issued ?? []).length > 0 && (
          <>
            <dt>issued by</dt>
            <dd>
              {(proof.issued ?? []).map((l, i) => (
                <span key={i} className="evline">
                  <strong>{l.credentialType}</strong> — <DidTag did={l.issuer} /> (a third party)
                </span>
              ))}
            </dd>
          </>
        )}
        {proof.validUntil && (
          <>
            <dt>expires</dt>
            <dd>
              {new Date(proof.validUntil).toLocaleString()}{' '}
              {new Date(proof.validUntil).getTime() < Date.now() ? (
                <span className="chip proof-denied">expired</span>
              ) : (
                <span className="chip proof-granted">valid</span>
              )}
            </dd>
          </>
        )}
        {proof.credentialDid && (
          <>
            <dt>credential</dt>
            <dd><DidTag did={proof.credentialDid} /></dd>
          </>
        )}
      </dl>
      <p className="note dim">The evidence graph is sealed to the Sovereign; this is the Warden's summary of what it attested.</p>
    </div>
  );
}

function ProofGroup({ g }: { g: NonNullable<ProofRecord['evidence']>[number] }) {
  return (
    <>
      <dt>evidence</dt>
      <dd>
        <span className="evline">
          <strong>{g.count}</strong> witnessed {g.kind} observation(s)
          {g.observedFrom && (
            <> · {new Date(g.observedFrom).toLocaleDateString()} → {new Date(g.observedTo).toLocaleDateString()}</>
          )}
        </span>
        <span className="evline dim">root <code className="mono">{g.merkleRoot.slice(0, 20)}…</code></span>
        {g.witnessedBy.length > 0 && (
          <span className="evline">by {g.witnessedBy.map((w) => <DidTag key={w} did={w} />)}</span>
        )}
      </dd>
    </>
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
