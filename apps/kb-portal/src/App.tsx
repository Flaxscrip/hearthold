import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

import { portalApi, type KbCitation, type KbResult, type Session } from './api';

// Copy is env-driven so the portal is reusable across KBs; the arcane aesthetic is the default look.
const env = import.meta.env;
const KB_ID = (env.VITE_KB_ID as string | undefined) ?? 'city-of-mages';
const KB_TITLE = (env.VITE_KB_TITLE as string | undefined) ?? 'Knowledge Portal';
const KB_EYEBROW = (env.VITE_KB_EYEBROW as string | undefined) ?? 'The Knowledge Base';
const KB_LEDE = (env.VITE_KB_TAGLINE as string | undefined) ?? 'Ask, and the record answers.';
const KB_EXAMPLES = ((env.VITE_KB_EXAMPLES as string | undefined) ?? '')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);
// The Sovereign Signet web app (or any Archon web wallet) that handles ?challenge=… deep links.
const SIGNET_URL = (env.VITE_SIGNET_URL as string | undefined) ?? 'https://wallet.archon.technology';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <>
      <Sky />
      <div className="wrap">
        <header>
          <div className="seal">
            <span className="glyph">✶</span>
            <span className="nm">{KB_TITLE}</span>
          </div>
          {session ? (
            <div className="who">
              <span className="okdot" />
              <code title={session.did}>{session.did.slice(0, 14)}…</code>
              <button className="login" onClick={() => setSession(null)}>
                sign out
              </button>
            </div>
          ) : (
            <button className="login" onClick={() => setLoginOpen(true)}>
              <span className="k">⚿</span> Enter as a creator
            </button>
          )}
        </header>

        <main>
          <p className="kicker">{KB_EYEBROW}</p>
          <h1>{KB_TITLE}</h1>
          <p className="lede">{KB_LEDE}</p>
          <AskBox />
          {session && <Contribute session={session} />}
        </main>

        <footer>
          <span className="g">
            Reading is <b>open</b> to all
          </span>
          <span className="sep">·</span>
          <span className="g">
            Publishing is <b>curated</b> — creators sign in with their own wallet
          </span>
          <span className="sep">·</span>
          <span className="g">Your keys never enter this page; the record keeps no note of who asked what</span>
        </footer>
      </div>

      {loginOpen && (
        <LoginModal
          onClose={() => setLoginOpen(false)}
          onSession={(s) => {
            setSession(s);
            setLoginOpen(false);
          }}
        />
      )}
    </>
  );
}

// ── Anonymous public query — no wallet. Answered by the portal's read-only oracle reader. ──
function AskBox() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [cites, setCites] = useState<KbCitation[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const ask = useCallback(
    async (question?: string) => {
      const query = (question ?? q).trim();
      if (!query) return;
      setBusy(true);
      setErr(null);
      setAnswer(null);
      setCites([]);
      try {
        const r = await portalApi.ask(KB_ID, query);
        setAnswer(r.answer);
        setCites(r.citations ?? []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [q],
  );

  return (
    <>
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <div className="field">
          <span className="q">✧</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ask the chronicle anything…"
            aria-label="Ask the chronicle"
          />
          <button type="submit" disabled={busy || !q.trim()}>
            {busy ? 'consulting…' : 'Consult'}
          </button>
        </div>
        {KB_EXAMPLES.length > 0 && (
          <div className="chips">
            {KB_EXAMPLES.map((x) => (
              <button
                type="button"
                key={x}
                className="chip"
                onClick={() => {
                  setQ(x);
                  void ask(x);
                }}
              >
                {x}
              </button>
            ))}
          </div>
        )}
        <div className="assur">
          <span className="dot" /> Reading is open to all · answers draw only on the public chronicle
        </div>
      </form>

      {answer && (
        <section className="answer" aria-live="polite">
          <div className="head">
            <span className="o">✧</span> From the chronicle
          </div>
          <div className="body">
            <p className="a">{answer}</p>
            {cites.length > 0 && (
              <div className="sources">
                <p className="lbl">Sources</p>
                <div className="srcrow">
                  {cites.map((c) => (
                    <span className="src" key={c.artefactId} title={c.artefactId}>
                      <span className="n">{c.kind}</span>
                      {c.scope && <span className="badge">{c.scope === 'private' ? '🔒' : '🌐'}</span>}
                      <span className="sc">{c.score.toFixed(2)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <p className="caveat">Machine-derived from the public chronicle · your query is not logged.</p>
          </div>
        </section>
      )}
      {err && <p className="err">✗ {err}</p>}
    </>
  );
}

// ── Creator sign-in (challenge/response) — a modal, not the default path. ──
function LoginModal({ onClose, onSession }: { onClose: () => void; onSession: (s: Session) => void }) {
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

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  useEffect(() => {
    if (!loginId) return;
    const iv = window.setInterval(async () => {
      try {
        const r = await portalApi.loginPoll(loginId);
        if (r.status === 'ready' && r.session) {
          window.clearInterval(iv);
          onSession(r.session);
        } else if (r.status === 'unknown') {
          window.clearInterval(iv);
          setErr('This sign-in expired. Close and try again.');
        }
      } catch {
        /* transient; keep polling */
      }
    }, 2000);
    return () => window.clearInterval(iv);
  }, [loginId, onSession]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    if (!challenge) return;
    await navigator.clipboard.writeText(challenge);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
        <div className="top">
          <div className="glyph">⚿</div>
          <h2 id="loginTitle">Enter as a creator</h2>
          <p className="sub">
            Publishing is curated. Prove control of your <code>did:cid</code> — your keys never leave your wallet.
          </p>
        </div>
        <div className="modalbody">
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
              <a className="btn ghost" href={deepLink} target="_blank" rel="noreferrer">
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
          <p className="waiting">
            <span className="pulse" /> waiting for your wallet to respond…
          </p>
          {err && <p className="err">✗ {err}</p>}
        </div>
        <div className="modalact">
          <button className="btn ghost" onClick={onClose}>
            Not now — just browsing
          </button>
        </div>
        <p className="noKeys">
          Challenge / response — you sign locally. <b>No password, no keys ever leave your device.</b>
        </p>
      </div>
    </div>
  );
}

// ── Creator: contribute to the chronicle (shared) or a private draft. ──
function Contribute({ session }: { session: Session }) {
  const [kind, setKind] = useState('document');
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'shared' | 'private'>(session.defaultScope ?? 'shared');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const spaces = session.memberPartitions === true;

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
        setMsg(spaces && scope === 'private' ? '✓ saved to your private drafts' : '✓ published to the shared chronicle');
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
      <h2>Contribute</h2>
      {spaces ? (
        <>
          <p className="dim">Choose where this goes:</p>
          <div className="kinds scope-toggle">
            <button className={scope === 'shared' ? 'pick on' : 'pick'} onClick={() => setScope('shared')}>
              🌐 Shared chronicle
            </button>
            <button className={scope === 'private' ? 'pick on' : 'pick'} onClick={() => setScope('private')}>
              🔒 Private draft
            </button>
          </div>
          <p className="tiny dim">
            {scope === 'private'
              ? 'Kept in your own partition — visible only to you.'
              : 'Published to the public chronicle for every reader (requires curator rights).'}
          </p>
        </>
      ) : (
        <p className="dim">Publish shared knowledge to the chronicle (requires curator write authorization).</p>
      )}
      <div className="kinds">
        {['document', 'event', 'activity', 'location'].map((k) => (
          <button key={k} className={kind === k ? 'pick on' : 'pick'} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
      <textarea rows={4} placeholder="Knowledge the chronicle should hold…" value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={add} disabled={busy || !text.trim()}>
        {busy ? 'publishing…' : 'Contribute'}
      </button>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">✗ {err}</p>}
    </section>
  );
}

// ── Ambient sigil-field (very subtle; static under reduced-motion). ──
function Sky() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let stars: { x: number; y: number; r: number; a: number; tw: number; p: number }[] = [];
    let raf = 0;
    const size = (): void => {
      cv.width = window.innerWidth;
      cv.height = window.innerHeight;
    };
    const seed = (): void => {
      stars = [];
      const n = Math.min(90, Math.floor((window.innerWidth * window.innerHeight) / 16000));
      for (let i = 0; i < n; i += 1) {
        stars.push({
          x: Math.random() * cv.width,
          y: Math.random() * cv.height,
          r: Math.random() * 1.3 + 0.3,
          a: Math.random() * 0.5 + 0.15,
          tw: Math.random() * 0.02 + 0.004,
          p: Math.random() * 6.28,
        });
      }
    };
    const draw = (): void => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      for (const s of stars) {
        s.p += s.tw;
        const a = reduce ? s.a : s.a * (0.6 + 0.4 * Math.sin(s.p));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, 6.29);
        ctx.fillStyle = `rgba(201, 196, 255, ${a})`;
        ctx.fill();
      }
      if (!reduce) raf = window.requestAnimationFrame(draw);
    };
    size();
    seed();
    draw();
    const onResize = (): void => {
      size();
      seed();
      if (reduce) draw();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);
  return <canvas id="sky" ref={ref} aria-hidden="true" />;
}
