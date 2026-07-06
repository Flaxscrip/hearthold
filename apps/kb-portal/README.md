# Knowledge Portal — the public Mage's browser face

A browser front-end where a member proves control of their `did:cid` and queries/updates a shared
Knowledge Base. The member's wallet stays in the browser; it only **signs** each request (`addProof`).
The signed request goes to the **Mage** (`witness kb-web`), which relays it over DIDComm to the private
**Warden**, which authenticates end-to-end, authorizes (a KB trust-registry group), and serves.

```
 browser (member's wallet, signs)  ──HTTP──▶  Mage: witness kb-web  ──DIDComm──▶  Warden (KB brain)
   WalletWeb · CipherWeb · addProof            (HTTP→DIDComm bridge)              authenticate·authorize·serve
```

The browser produces the **byte-for-byte same signed `KbRequestStatement`** the `sovereign kb-*` CLI
produces, so the Warden's `KbService` verifies it unchanged — no backend changes for the web path.

## Run locally (three processes)

```bash
# 0. provision (once): a KB Warden, a Mage, and grant a member DID
HEARTHOLD_PASSPHRASE=… warden kb-init drake-kb
HEARTHOLD_PASSPHRASE=… warden kb-grant <memberDid> both

# 1. the private Warden (serves the KB over DIDComm)
HEARTHOLD_PASSPHRASE=… warden serve

# 2. the public Mage web bridge (HTTP → DIDComm)
HEARTHOLD_PASSPHRASE=… HEARTHOLD_WARDEN_DID=<wardenDid> witness kb-web 4313

# 3. the browser app
cd apps/kb-portal && npm run dev     # http://localhost:5176
```

The member opens the page, unlocks their Archon wallet (passphrase), and asks/contributes.

## Configuration (Vite env)

| Var | Default | Meaning |
|-----|---------|---------|
| `VITE_PORTAL_URL` | `http://127.0.0.1:4313` | the Mage `kb-web` HTTP bridge |
| `VITE_GATEKEEPER_URL` | `http://flaxlap.local:4224` | Archon gatekeeper (browser Keymaster) |
| `VITE_KB_ID` | `drake-kb` | which Knowledge Base this portal serves |
| `VITE_REGISTRY` | `hyperswarm` | registry a newly-created member DID is anchored on |

The Mage bridge binds to loopback by default; set `HEARTHOLD_PORTAL_HOST=0.0.0.0` (or a tailnet
address) on `witness kb-web` to expose it.

## Identity: unlock / create / recover

The **Connect** screen has three modes, so a member always has a way in:

- **Unlock** — an Archon wallet already in this browser (on archon.social it's in
  `localStorage['archon-keymaster']` → effectively SSO).
- **Create** — a fresh identity in the browser; the member gets a recovery phrase to back up.
- **Recover** — bring an existing DID (e.g. `flaxscrip`) into a fresh browser from its recovery phrase.
  The seed is used locally and never leaves the browser. Use this to reuse your own DID in demos.

Connecting only proves DID control (local); the member still needs `warden kb-grant <did>` before
Ask/Contribute succeed.

## Split-host deployment

The tiers can live on different machines — the portal only relates them by URL:

```
 browser ──HTTP──▶  Mage (witness kb-web)  ──DIDComm──▶  Warden (warden serve)  ──HTTP──▶  Ollama
  member's wallet    e.g. on archon.social                e.g. on flaxlap.local            e.g. megaflax.local
```

- **Warden** on **flaxlap.local** — holds the KB, classifies/embeds/recalls. Set its Ollama via
  `HEARTHOLD_OLLAMA_URL` (one var covers the classifier, the embedder, and recall answers):
  ```bash
  export HEARTHOLD_DATA_ROOT=~/.hearthold-kb          # fresh root → a NEW KB Warden + Mage
  export HEARTHOLD_NODE_URL=http://flaxlap.local:4222
  export HEARTHOLD_OLLAMA_URL=http://megaflax.local:11434
  warden kb-init drake-kb && warden serve
  ```
- **Ollama** on **megaflax.local** — pull the models there (`ollama pull nomic-embed-text`,
  `ollama pull qwen3:8b`) and bind to the network (`OLLAMA_HOST=0.0.0.0:11434 ollama serve`) so flaxlap
  can reach it. Verify: `curl http://megaflax.local:11434/api/tags`.
- **Mage** (`witness kb-web`) on **archon.social** — the public web face; relays to the Warden's DID over
  DIDComm. It touches neither Ollama nor any secret. Build the static app (`npm run build` → `dist/`),
  serve it behind the archon.social web server with `VITE_PORTAL_URL` → the Mage bridge and
  `VITE_GATEKEEPER_URL` → the node's gatekeeper.
- Provision a fresh **KB Warden + Mage + KB group** for the new database (new identities), then
  `warden kb-grant <memberDid> both` each member.
