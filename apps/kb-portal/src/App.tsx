import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

import { portalApi, type KbCitation, type KbResult, type Session } from './api';

const KB_ID = (import.meta.env.VITE_KB_ID as string | undefined) ?? 'drake-kb';
// The Sovereign Signet web app (or any Archon web wallet) that handles ?challenge=… deep links.
const SIGNET_URL = (import.meta.env.VITE_SIGNET_URL as string | undefined) ?? 'https://wallet.archon.technology';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <span className="sigil">🜁</span>
          <div>
            <h1>Knowledge Portal</h1>
            <p className="sub">
              a shared, authorized Knowledge Base · <code>{KB_ID}</code>
            </p>
          </div>
        </div>
        {session && (
          <button className="ghost" onClick={() => setSession(null)}>
            {session.did.slice(0, 16)}… · sign out
          </button>
        )}
      </header>

      {!session ? <Login onSession={setSession} /> : <Portal session={session} />}

      <footer className="foot">
        Your keys never enter this page — you sign in with your own wallet (challenge/response). The
        portal (a Mage) only carries your request to the Warden, which keeps no record of who asked what.
      </footer>
    </div>
  );
}

function Login({ onSession }: { onSession: (s: Session) => void }) {
  const [challenge, setChallenge] = useState<string | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  const deepLink = challenge ? `${SIGNET_URL}/?challenge=${challenge}` : '';

  const start = useCallback(async () => {
    setErr(null);
    try {
      const { loginId: id, challenge: ch } = await portalApi.loginStart(KB_ID);
      setLoginId(id);
      setChallenge(ch);
      setQr(await QRCode.toDataURL(`${SIGNET_URL}/?challenge=${ch}`, { margin: 1, width: 224 }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Begin a login attempt on mount.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  // Poll until the wallet has responded and the Warden has minted a session.
  useEffect(() => {
    if (!loginId) return;
    const iv = window.setInterval(async () => {
      try {
        const r = await portalApi.loginPoll(loginId);
        if (r.status === 'ready' && r.session) {
          window.clearInterval(iv);
          onSession(r.session);
        } else if (r.status === 'unknown') {
          window.clearInterval(iv); // challenge expired — offer a retry
          setErr('This sign-in expired. Refresh to try again.');
        }
      } catch {
        /* transient; keep polling */
      }
    }, 2000);
    return () => window.clearInterval(iv);
  }, [loginId, onSession]);

  const copy = async () => {
    if (!challenge) return;
    await navigator.clipboard.writeText(challenge);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="card connect">
      <h2>Sign in with your wallet</h2>
      <p className="dim">
        Prove control of your <code>did:cid</code> — three ways, your keys never leave your wallet:
      </p>

      {qr ? (
        <a className="qrwrap" href={deepLink} target="_blank" rel="noreferrer" title="Open in your Signet">
          <img className="qr" src={qr} alt="Scan this challenge with your Archon wallet" />
        </a>
      ) : (
        <div className="qrwrap placeholder">{err ? '—' : 'preparing…'}</div>
      )}

      <ol className="ways">
        <li>
          <strong>Scan</strong> the code with your phone&rsquo;s Archon wallet
        </li>
        <li>
          <a className="btn" href={deepLink} target="_blank" rel="noreferrer">
            Open in Signet
          </a>{' '}
          (or click the code)
        </li>
        <li>
          <button className="btn ghost" onClick={copy} disabled={!challenge}>
            {copied ? 'copied ✓' : 'Copy challenge DID'}
          </button>{' '}
          to paste into any wallet
        </li>
      </ol>

      {challenge && <code className="challenge">{challenge}</code>}
      <p className="tiny dim waiting">
        <span className="pulse" /> waiting for your wallet to respond…
      </p>
      {err && <p className="err">✗ {err}</p>}
    </section>
  );
}

function Portal({ session }: { session: Session }) {
  const [tab, setTab] = useState<'query' | 'contribute'>('query');
  return (
    <>
      <div className="who card">
        <span className="okdot" /> Signed in as <code title={session.did}>{session.did.slice(0, 30)}…</code>
      </div>
      <div className="tabs">
        <button className={tab === 'query' ? 'on' : ''} onClick={() => setTab('query')}>
          Ask
        </button>
        <button className={tab === 'contribute' ? 'on' : ''} onClick={() => setTab('contribute')}>
          Contribute
        </button>
      </div>
      {tab === 'query' ? <QueryPanel session={session} /> : <ContributePanel session={session} />}
    </>
  );
}

function QueryPanel({ session }: { session: Session }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [cites, setCites] = useState<KbCitation[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const ask = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    setAnswer(null);
    setCites([]);
    try {
      const { result }: { result: KbResult } = await portalApi.sessionRequest({
        token: session.token,
        kbId: KB_ID,
        action: 'query',
        query: q.trim(),
      });
      if (result.type === 'hearthold/kb-error') setErr(result.reason);
      else if (result.action === 'query') {
        setAnswer(result.answer);
        setCites(result.citations);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <textarea
        rows={2}
        placeholder="Ask the Knowledge Base a question…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => (e.key === 'Enter' && (e.metaKey || e.ctrlKey) ? void ask() : undefined)}
      />
      <button onClick={ask} disabled={busy || !q.trim()}>
        {busy ? 'asking…' : 'Ask'}
      </button>
      {answer && (
        <div className="answer">
          <p className="a">🔎 {answer}</p>
          {cites.length > 0 && (
            <ul className="cites">
              {cites.map((c) => (
                <li key={c.artefactId}>
                  <span className="kind">{c.kind}</span>
                  {c.scope && <span className={`scope-badge ${c.scope}`}>{c.scope === 'private' ? '🔒 yours' : '🌐 shared'}</span>}
                  <span className="when">{new Date(c.observedAt).toLocaleDateString()}</span>
                  <span className="score">{c.score.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="tiny dim">machine-derived from the KB · your query is not logged</p>
        </div>
      )}
      {err && <p className="err">✗ {err}</p>}
    </section>
  );
}

function ContributePanel({ session }: { session: Session }) {
  const [kind, setKind] = useState('event');
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'shared' | 'private'>(session.defaultScope ?? 'shared');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const spaces = session.memberPartitions === true; // this KB grants each member a private partition

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const { result }: { result: KbResult } = await portalApi.sessionRequest({
        token: session.token,
        kbId: KB_ID,
        action: 'update',
        kind,
        text: text.trim(),
        scope: spaces ? scope : undefined,
      });
      if (result.type === 'hearthold/kb-error') setErr(result.reason);
      else if (result.action === 'update') {
        // Trust the Warden's word on where this landed, NOT the button the user clicked. If a `scope`
        // was dropped anywhere on the wire (e.g. a stale relay), the server's echo won't match what we
        // asked for — surface that loudly instead of pretending the private write succeeded.
        const requested = spaces ? scope : 'shared';
        if (result.scope !== requested) {
          setErr(`Warning: asked to save this as ${requested}, but the Warden stored it as ${result.scope}. It was NOT saved where you intended — please verify before relying on this.`);
        } else {
          setMsg(result.scope === 'private' ? '✓ saved to your private notes (only you can see it)' : '✓ contributed to the shared Knowledge Base');
          setText('');
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      {spaces ? (
        <>
          <p className="dim">Choose where this goes:</p>
          <div className="kinds scope-toggle">
            <button className={scope === 'shared' ? 'pick on' : 'pick'} onClick={() => setScope('shared')}>
              🌐 Shared
            </button>
            <button className={scope === 'private' ? 'pick on' : 'pick'} onClick={() => setScope('private')}>
              🔒 Private (only you)
            </button>
          </div>
          <p className="tiny dim">
            {scope === 'private'
              ? 'Stored in your own private partition — visible only to you, never to other members.'
              : 'Shared knowledge for every member of this Knowledge Base.'}
          </p>
        </>
      ) : (
        <p className="dim">
          Contribute <strong>shared knowledge</strong> (requires write authorization) — never your private
          vault, only knowledge meant for the community.
        </p>
      )}
      <div className="kinds">
        {['event', 'document', 'activity', 'location'].map((k) => (
          <button key={k} className={kind === k ? 'pick on' : 'pick'} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
      <textarea rows={3} placeholder="A fact the guild should know…" value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={add} disabled={busy || !text.trim()}>
        {busy ? 'contributing…' : 'Contribute'}
      </button>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">✗ {err}</p>}
    </section>
  );
}
