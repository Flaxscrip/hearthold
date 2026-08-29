/**
 * Local demo web UI for the "agency" book KB — a self-contained page you open from anywhere on your LAN to
 * ask David's corpus questions and read the reasoned, cited answers.
 *
 * This is a REHEARSAL surface, not the production portal: it answers as the KB owner (through the KbService's
 * challenge/response wall internally) and puts NO auth on the web page, so treat it as a trusted-LAN demo of
 * a PUBLIC-sensitivity book — not the member-gated portal David would eventually log into. Bind stays on the
 * host you choose; nothing here is exposed to the internet unless you route it there.
 *
 *   HEARTHOLD_DATA_ROOT=… HEARTHOLD_PASSPHRASE=… npm run agency-web      # → prints the LAN URL to open
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  signKbRequest,
  type KbRequestStatement,
  type KeymasterHandle,
} from '@hearthold/core';
import { buildKbServices } from '@hearthold/warden/kb-config';

const KB_ID = process.env.AGENCY_KB_ID ?? 'agency';
const PORT = Number(process.env.AGENCY_WEB_PORT ?? 4433);
const HOST = process.env.AGENCY_WEB_HOST ?? '0.0.0.0'; // LAN by default — this is a local-network demo
const PASS = process.env.HEARTHOLD_PASSPHRASE ?? 'agency-demo';

const SUGGESTIONS = [
  'What is the Sovereign Kernel, and why does it matter for AI alignment?',
  'How does the corpus distinguish constitutive alignment from substantive alignment?',
  'What are the four load-bearing components of authored agency?',
  'What does axionic agency say about value, ethics, and the good?',
  'What is the critique of preference-based alignment?',
];

const PAGE = (): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Architecture of Agency</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Newsreader:ital,opsz@0,6..72;1,6..72&display=swap" rel="stylesheet">
<style>
  :root{--paper:#f4efe6;--ink:#211d17;--muted:#6a6156;--rule:#d8cfbf;--accent:#7c4a2d;--card:#fbf8f2}
  @media (prefers-color-scheme:dark){:root{--paper:#171410;--ink:#ece4d6;--muted:#a1968585;--muted:#a29684;--rule:#332d24;--accent:#d59b6f;--card:#1f1a14}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:Newsreader,Georgia,serif;font-size:18px;line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:52rem;margin:0 auto;padding:clamp(1.2rem,4vw,3rem) 1.25rem 4rem}
  header{border-bottom:1px solid var(--rule);padding-bottom:1.4rem;margin-bottom:1.8rem}
  .eyebrow{font-family:Fraunces,serif;font-size:.72rem;letter-spacing:.22em;text-transform:uppercase;color:var(--accent);font-weight:600}
  h1{font-family:Fraunces,serif;font-weight:600;font-size:clamp(2rem,6vw,3.1rem);line-height:1.04;margin:.3rem 0 .2rem;text-wrap:balance}
  .sub{color:var(--muted);font-style:italic;margin:0}
  form{display:flex;gap:.6rem;margin:0 0 1rem;flex-wrap:wrap}
  textarea{flex:1 1 20rem;min-height:3.4rem;resize:vertical;font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--rule);border-radius:.5rem;padding:.7rem .85rem}
  textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
  button{font-family:Fraunces,serif;font-weight:600;font-size:1rem;background:var(--accent);color:#fff;border:0;border-radius:.5rem;padding:.7rem 1.4rem;cursor:pointer}
  button:disabled{opacity:.55;cursor:progress}
  .chips{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:2rem}
  .chip{font-size:.82rem;color:var(--muted);background:transparent;border:1px solid var(--rule);border-radius:2rem;padding:.32rem .7rem;cursor:pointer;font-family:Newsreader,serif}
  .chip:hover{border-color:var(--accent);color:var(--accent)}
  #out{min-height:2rem}
  .answer{background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:.5rem;padding:1.1rem 1.3rem;margin-top:.5rem}
  .answer strong{font-weight:600}
  .q{font-family:Fraunces,serif;font-weight:600;font-size:1.15rem;margin:0 0 .6rem}
  .cite{color:var(--muted);font-size:.85rem;font-style:italic;margin-top:.9rem;border-top:1px solid var(--rule);padding-top:.7rem}
  .thinking{color:var(--muted);font-style:italic}
  .dot{animation:blink 1.4s infinite}.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
  @keyframes blink{0%,100%{opacity:.2}50%{opacity:1}}
  footer{margin-top:3rem;padding-top:1.2rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.8rem}
</style></head>
<body><div class="wrap">
  <header>
    <div class="eyebrow">The Chronicle · A Hearthold Knowledge Base</div>
    <h1>The Architecture of Agency</h1>
    <p class="sub">Ask the corpus. Answers are reasoned over the manuscript and cite it — the text itself never leaves the custodian.</p>
  </header>
  <form id="f">
    <textarea id="q" placeholder="Ask a question about agency, alignment, value, governance…" autofocus></textarea>
    <button id="go" type="submit">Ask</button>
  </form>
  <div class="chips" id="chips"></div>
  <div id="out"></div>
  <footer>Local demo · reasoned with a local model, the manuscript sealed at rest · member-gated in production.</footer>
</div>
<script>
  const SUG = ${JSON.stringify(SUGGESTIONS)};
  const chips = document.getElementById('chips');
  SUG.forEach(s => { const b=document.createElement('button'); b.className='chip'; b.type='button'; b.textContent=s; b.onclick=()=>{document.getElementById('q').value=s; ask();}; chips.appendChild(b); });
  const esc = t => t.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const render = t => esc(t).replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>').split(/\\n{2,}/).map(p=>'<p>'+p.replace(/\\n/g,'<br>')+'</p>').join('');
  const out = document.getElementById('out'), go = document.getElementById('go');
  async function ask(){
    const q = document.getElementById('q').value.trim(); if(!q) return;
    go.disabled = true;
    out.innerHTML = '<div class="answer"><p class="q">'+esc(q)+'</p><p class="thinking">reasoning over the corpus<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></p></div>';
    try{
      const r = await fetch('/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q})});
      const j = await r.json();
      if(!r.ok || j.error){ out.innerHTML = '<div class="answer"><p class="q">'+esc(q)+'</p><p>'+esc(j.error||('error '+r.status))+'</p></div>'; }
      else { out.innerHTML = '<div class="answer"><p class="q">'+esc(q)+'</p>'+render(j.answer||'(no answer)')+'<p class="cite">'+(j.citations||0)+' citation(s) from the manuscript.</p></div>'; }
    }catch(e){ out.innerHTML = '<div class="answer"><p>'+esc(String(e))+'</p></div>'; }
    go.disabled = false;
  }
  document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); ask(); });
</script>
</body></html>`;

function lanUrls(): string[] {
  const urls: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
    }
  }
  return urls;
}

async function main(): Promise<void> {
  const config = { ...loadConfig(), answerModel: process.env.HEARTHOLD_ANSWER_MODEL ?? 'qwen3:8b' };
  const warden: KeymasterHandle = await openKeymaster('warden', config, PASS);
  const owner: KeymasterHandle = await openKeymaster('sovereign', config, PASS);
  const wid = await ensureIdentity(warden, config);
  const ownerId = await ensureIdentity(owner, config);
  const kbs = await buildKbServices(warden, config, wid.did);
  const kb = kbs.get(KB_ID);
  if (!kb) throw new Error(`KB "${KB_ID}" not found under ${config.dataRoot} — build it first (npm run build:agency-kb) with the same HEARTHOLD_DATA_ROOT + HEARTHOLD_PASSPHRASE.`);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE());
      return;
    }
    if (req.method === 'POST' && req.url === '/ask') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', async () => {
        try {
          const q = String((JSON.parse(body || '{}') as { q?: string }).q ?? '').trim();
          if (!q) throw new Error('empty question');
          const nonce = kb.challenge().nonce;
          const signed = await signKbRequest(owner, { action: 'query', requester: ownerId.did, kbId: KB_ID, nonce, query: q, k: 6 } as KbRequestStatement);
          const reply = await kb.serve(signed);
          if (reply.type !== 'hearthold/kb-result') throw new Error((reply as { reason?: string }).reason ?? reply.type);
          const r = reply as { answer?: string; citations?: unknown[] };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ answer: r.answer ?? '', citations: r.citations?.length ?? 0 }));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }
    res.writeHead(404).end('not found');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`agency-web: port ${PORT} is already in use — set AGENCY_WEB_PORT to a free port.\n`);
    } else {
      process.stderr.write(`agency-web: server error — ${err.message}\n`);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    process.stdout.write(`\n📖  The Architecture of Agency — local demo UI\n`);
    process.stdout.write(`    KB "${KB_ID}" · owner ${ownerId.did.slice(0, 24)}…\n`);
    process.stdout.write(`    serving on ${HOST}:${PORT}\n`);
    const urls = lanUrls();
    if (urls.length) {
      process.stdout.write(`    open from this Mac:      http://localhost:${PORT}\n`);
      process.stdout.write(`    open from your network:  ${urls.join('  |  ')}\n`);
    }
    process.stdout.write(`    (Ctrl-C to stop) — LOCAL DEMO: no auth on the page, serve on a trusted LAN only.\n\n`);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`agency-web: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
