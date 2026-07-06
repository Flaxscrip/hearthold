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

The Mage bridge binds to loopback by default; set `HEARTHOLD_PORTAL_HOST=0.0.0.0` (or a tailnet
address) on `witness kb-web` to expose it.

## Deploy to archon.social

On archon.social the member's wallet is already in `localStorage['archon-keymaster']`, so the connect
step is effectively SSO. Build the static app (`npm run build` → `dist/`), serve it behind the
archon.social web server, point `VITE_PORTAL_URL` at the Mage bridge and `VITE_GATEKEEPER_URL` at the
node's gatekeeper, and provision a fresh KB Warden + Mage + KB group for the new database.
