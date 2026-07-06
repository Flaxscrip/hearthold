import { useState } from 'react';

import { connect, createIdentity, recover, useIdentity, signStatement, disconnect, type Member } from './keymaster';
import { portalApi, type KbCitation, type KbResult } from './api';

const GATEKEEPER_URL = (import.meta.env.VITE_GATEKEEPER_URL as string | undefined) ?? 'http://flaxlap.local:4224';
const KB_ID = (import.meta.env.VITE_KB_ID as string | undefined) ?? 'drake-kb';
const REGISTRY = (import.meta.env.VITE_REGISTRY as string | undefined) ?? 'hyperswarm';

/** A KB request statement — signed in the browser, verified by the Warden (matches core/protocol.ts). */
interface KbRequestStatement {
  action: 'query' | 'update';
  requester: string;
  kbId: string;
  nonce: string;
  query?: string;
  kind?: string;
  text?: string;
}

/** Fetch a fresh nonce, sign the statement with the member's wallet, submit via the Mage. */
async function submit(body: Omit<KbRequestStatement, 'nonce'>): Promise<KbResult> {
  const { nonce } = await portalApi.challenge(body.kbId);
  const signed = await signStatement<KbRequestStatement>({ ...body, nonce } as KbRequestStatement);
  const { result } = await portalApi.request(signed);
  return result;
}

export function App() {
  const [member, setMember] = useState<Member | null>(null);
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
        {member && (
          <button className="ghost" onClick={() => (disconnect(), setMember(null))}>
            {member.name} · disconnect
          </button>
        )}
      </header>

      {!member ? <Connect onConnected={setMember} /> : <Portal member={member} />}

      <footer className="foot">
        Your wallet stays in your browser — the portal (a Mage) only carries your signed request to the
        Warden. Answers are machine-derived from the KB; the Warden keeps no record of who asked what.
      </footer>
    </div>
  );
}

type ConnectMode = 'unlock' | 'create' | 'recover';

function Connect({ onConnected }: { onConnected: (m: Member) => void }) {
  const [mode, setMode] = useState<ConnectMode>('unlock');
  const [passphrase, setPassphrase] = useState('');
  const [name, setName] = useState('');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ member: Member; mnemonic: string } | null>(null);
  const [recoveredIds, setRecoveredIds] = useState<string[] | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doUnlock = () => run(async () => onConnected(await connect(GATEKEEPER_URL, passphrase)));
  const doCreate = () =>
    run(async () => setCreated(await createIdentity(GATEKEEPER_URL, passphrase, name.trim(), REGISTRY)));
  const doRecover = () =>
    run(async () => {
      const ids = await recover(GATEKEEPER_URL, passphrase, seed);
      if (ids.length === 1) onConnected(await useIdentity(ids[0] as string));
      else setRecoveredIds(ids);
    });

  // After create — show the mnemonic so it gets backed up before continuing.
  if (created) {
    return (
      <section className="card connect">
        <h2>Back up your recovery phrase</h2>
        <p className="dim">
          This is the ONLY way to restore <code>{created.member.name}</code> ({created.member.did.slice(0, 20)}…).
          Write it down and keep it safe — it is never shown again and never leaves this browser.
        </p>
        <pre className="seed">{created.mnemonic}</pre>
        <button onClick={() => onConnected(created.member)}>I&rsquo;ve saved it — continue</button>
      </section>
    );
  }

  // After recover with multiple identities — let the member pick which DID to act as.
  if (recoveredIds) {
    return (
      <section className="card connect">
        <h2>Choose your identity</h2>
        <p className="dim">Recovered {recoveredIds.length} identities from your seed.</p>
        <div className="idlist">
          {recoveredIds.map((id) => (
            <button
              key={id}
              className="ghost idpick"
              disabled={busy}
              onClick={() => run(async () => onConnected(await useIdentity(id)))}
            >
              {id}
            </button>
          ))}
        </div>
        {err && <p className="err">✗ {err}</p>}
      </section>
    );
  }

  return (
    <section className="card connect">
      <h2>Prove who you are</h2>
      <div className="tabs">
        <button className={mode === 'unlock' ? 'on' : ''} onClick={() => setMode('unlock')}>
          Unlock
        </button>
        <button className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>
          Create
        </button>
        <button className={mode === 'recover' ? 'on' : ''} onClick={() => setMode('recover')}>
          Recover
        </button>
      </div>

      {mode === 'unlock' && (
        <>
          <p className="dim">
            Unlock your Archon wallet already in this browser to prove control of your <code>did:cid</code>.
          </p>
          <input
            type="password"
            placeholder="wallet passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doUnlock()}
            autoFocus
          />
          <button onClick={doUnlock} disabled={busy || !passphrase}>
            {busy ? 'unlocking…' : 'Connect wallet'}
          </button>
        </>
      )}

      {mode === 'create' && (
        <>
          <p className="dim">Create a fresh identity in this browser. You&rsquo;ll get a recovery phrase to back up.</p>
          <input placeholder="identity name (e.g. flaxscrip)" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            type="password"
            placeholder="choose a wallet passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <button onClick={doCreate} disabled={busy || !name.trim() || !passphrase}>
            {busy ? 'creating…' : 'Create identity'}
          </button>
        </>
      )}

      {mode === 'recover' && (
        <>
          <p className="dim">
            Reuse an existing DID (e.g. <code>flaxscrip</code>) — enter its recovery phrase. Your seed is
            used locally and never leaves this browser.
          </p>
          <textarea
            rows={2}
            placeholder="12-word recovery phrase"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
          <input
            type="password"
            placeholder="set a wallet passphrase for this browser"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <button onClick={doRecover} disabled={busy || !seed.trim() || !passphrase}>
            {busy ? 'recovering…' : 'Recover identity'}
          </button>
        </>
      )}

      {err && <p className="err">✗ {err}</p>}
      <p className="tiny dim">
        node: {GATEKEEPER_URL} · registry: {REGISTRY}
      </p>
    </section>
  );
}

function Portal({ member }: { member: Member }) {
  const [tab, setTab] = useState<'query' | 'contribute'>('query');
  return (
    <>
      <div className="who card">
        <span className="okdot" /> Connected as <code title={member.did}>{member.did.slice(0, 30)}…</code>
      </div>
      <div className="tabs">
        <button className={tab === 'query' ? 'on' : ''} onClick={() => setTab('query')}>
          Ask
        </button>
        <button className={tab === 'contribute' ? 'on' : ''} onClick={() => setTab('contribute')}>
          Contribute
        </button>
      </div>
      {tab === 'query' ? <QueryPanel member={member} /> : <ContributePanel member={member} />}
    </>
  );
}

function QueryPanel({ member }: { member: Member }) {
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
      const r = await submit({ action: 'query', requester: member.did, kbId: KB_ID, query: q.trim() });
      if (r.type === 'hearthold/kb-error') setErr(r.reason);
      else if (r.action === 'query') {
        setAnswer(r.answer);
        setCites(r.citations);
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

function ContributePanel({ member }: { member: Member }) {
  const [kind, setKind] = useState('event');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await submit({ action: 'update', requester: member.did, kbId: KB_ID, kind, text: text.trim() });
      if (r.type === 'hearthold/kb-error') setErr(r.reason);
      else if (r.action === 'update') {
        setMsg('✓ contributed to the Knowledge Base');
        setText('');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <p className="dim">
        Contribute <strong>shared knowledge</strong> to the KB (requires write authorization). This is
        never your private vault — only knowledge meant for the community.
      </p>
      <div className="kinds">
        {['event', 'document', 'activity', 'location'].map((k) => (
          <button key={k} className={kind === k ? 'pick on' : 'pick'} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
      <textarea
        rows={3}
        placeholder="A fact the guild should know…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button onClick={add} disabled={busy || !text.trim()}>
        {busy ? 'contributing…' : 'Contribute'}
      </button>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">✗ {err}</p>}
    </section>
  );
}
