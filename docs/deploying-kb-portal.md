# Redeploying the Knowledge Portal (kb.archon.social)

A checklist for upgrading the Knowledge Portal on a public host, capturing the two things that bite on an
upgrade — a **build-time** backend URL, and the **Witness→Emissary rename**. Handoff target: the
archon.social infra agent.

## Topology (what serves what)

- **Static SPA** (`apps/kb-portal/dist`) — served by nginx at `https://kb.archon.social/`.
- **`kb-web` bridge** — the public **Emissary** (`emissary kb-web <port>`), an HTTP→DIDComm relay. nginx
  reverse-proxies `https://kb.archon.social/api/kb/*` → the bridge (e.g. `127.0.0.1:4313`).
- **KB Warden** — `warden control` / `warden serve`, holds the KB; the bridge relays to it over DIDComm.

The SPA talks only to the bridge; the bridge talks only to the Warden. The member's keys never touch either.

## Gotcha 1 — `VITE_PORTAL_URL` is baked at BUILD time

`apps/kb-portal/src/api.ts` reads `import.meta.env.VITE_PORTAL_URL` and **falls back to
`http://127.0.0.1:4313`**. If you `npm run build` without setting it, every visitor's browser calls its
*own* `127.0.0.1:4313` over HTTP from an HTTPS page → mixed-content block → **"Failed to fetch"** (the
request never leaves the browser). This is a compile-time constant, not a runtime env — you must rebuild.

```bash
cd apps/kb-portal
VITE_PORTAL_URL=https://kb.archon.social VITE_KB_ID=<kb-id> npm run build
# deploy apps/kb-portal/dist/ to nginx's web root for kb.archon.social
```

Same-origin (`https://kb.archon.social`) is correct: nginx proxies `/api/kb/*` to the bridge, so the SPA
and API share an origin (no CORS, no mixed content). Verify the deployed bundle:

```bash
curl -s https://kb.archon.social/ | grep -oE '/assets/[^"]+\.js'      # find the bundle
curl -s https://kb.archon.social/assets/<bundle>.js | grep -o 'kb.archon.social'   # should appear; 127.0.0.1 should NOT
```

## Gotcha 2 — the Witness→Emissary rename

The world-facing agent was renamed **Witness → Emissary**. On upgrade:

- **Command changed:** `witness kb-web 4313` → **`emissary kb-web 4313`**. A start script / systemd unit
  still calling `witness …` fails to launch the bridge → nginx returns **502** on `/api/kb/*`.
- **Data folder moved:** `~/.hearthold/witness` → **`~/.hearthold/emissary`** (the wallet dir derives from
  the agent role). The Emissary identity re-provisions — run **`emissary init`** once if it's fresh.
- **`HEARTHOLD_WARDEN_DID`** must be the running KB Warden's DID. Confirm the Warden didn't also
  re-provision (`warden status`); if it did, re-point the bridge and re-check KB membership grants.

Bring the bridge up (one process per identity):

```bash
export HEARTHOLD_DATA_ROOT=~/.hearthold-kb           # the KB data root (not a personal vault)
export HEARTHOLD_NODE_URL=<drawbridge url>
emissary init                                        # once, if the emissary identity is fresh
HEARTHOLD_WARDEN_DID=<kb-warden-did> \
  HEARTHOLD_PORTAL_PUBLIC_URL=https://kb.archon.social \
  emissary kb-web 4313
```

`HEARTHOLD_PORTAL_PUBLIC_URL` is baked into the login challenge callback, so it must be the public origin
the member's wallet can reach (not localhost).

## Verify (each step, in order)

```bash
# 1. Bridge is up (not 502). A malformed/GET is fine — you want a JSON reply, not nginx HTML:
curl -s -X POST https://kb.archon.social/api/kb/login/start -H 'Content-Type: application/json' \
     -d '{"kbId":"<kb-id>"}'                          # → {"ok":true,"loginId":"…","challenge":"did:cid:…"}

# 2. SPA points at the right origin (from Gotcha 1's grep).

# 3. Open https://kb.archon.social/ — the QR should render; sign in with a wallet.
```

## Checklist

- [ ] `git pull` on the box; `npm ci && npm run build` (root) clean.
- [ ] Rebuild the SPA with `VITE_PORTAL_URL=https://kb.archon.social VITE_KB_ID=<kb-id>`; deploy `dist/`.
- [ ] Start the bridge with **`emissary kb-web`** (not `witness`); `emissary init` if fresh; set
      `HEARTHOLD_WARDEN_DID` + `HEARTHOLD_PORTAL_PUBLIC_URL`.
- [ ] `warden status` — confirm the KB Warden DID matches the bridge's `HEARTHOLD_WARDEN_DID`, and members
      are still granted (re-grant if the Warden re-provisioned).
- [ ] `curl …/api/kb/login/start` returns a challenge (not 502); the portal renders a QR and signs in.
```
