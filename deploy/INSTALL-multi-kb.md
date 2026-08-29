# Multi-KB deployment on one host — topology, provisioning, and the drift record

This host (the public KB box that fronts `kb.archon.social`) runs **several Hearthold KBs off one shared
`/opt/hearthold` git clone**. This file reconciles the per-KB provisioning that had drifted host-only — it
existed only on the box, in no git history — so the box is recoverable from the repo. Captured 2026-08-29
after archon-ops flagged the drift during PR #58 validation.

> ⚠️ **The `.env.*` files and the built `dist-*` portal assets are NOT in this repo** (see caveats). This
> reconciles the *unit files*, the *build recipe*, and the *topology*. A full rebuild still needs the
> per-KB env files (secrets) recreated on the host and the portal assets rebuilt.

## Topology — six services, one working directory

`/opt/hearthold` is the `WorkingDirectory=` of **six** systemd units. A `git pull` moves the code under all
six at once — so treat any bump as a coordinated, per-service deploy, never a blanket pull (especially while
the NIH-facing HATPro work is mid-flight).

| Service | Role | Port | Data root | KB |
|---|---|---|---|---|
| `hearthold-warden` | personal home Keeper (the Sovereign's own vault) | — | `~/.hearthold-warden` | personal |
| `hearthold-kb-mage` | public kb-web bridge for the personal KB | 4313 | `~/.hearthold-kb-mage` | `hearthold-kb` (kb.archon.social) |
| `hearthold-mages-warden` | custodian of `city-of-mages` | — | `~/.hearthold-mages-warden` | `city-of-mages` |
| `hearthold-mages-mage` | public kb-web bridge for `city-of-mages` | 4315 | `~/.hearthold-mages-mage` | `city-of-mages` (mages.archon.social) |
| `hearthold-hatpro-warden` | custodian of `hatpro-kb` (traveler profiles) | — | `~/.hearthold-hatpro-warden` | `hatpro-kb` (**NIH-facing**) |
| `hearthold-hatpro-mage` | public kb-web bridge for `hatpro-kb` | 4314 | `~/.hearthold-hatpro-mage` | `hatpro-kb` |

Each Mage binds `127.0.0.1:<port>` (loopback only); nginx terminates TLS and reverse-proxies each vhost.
Agents address each other by `did:cid` over DIDComm through the local Archon node (Drawbridge `:4222`), not
by URL.

## The two properties that were host-only and matter most

The mages/hatpro units are **not** just port/env/kbId substitutions of the personal `hearthold-*.service`
units. Two additions carry real weight and existed in no git history:

1. **`After=…hearthold-<kb>-warden.service`** on each Mage — start the custodian before its bridge so the
   mailbox has a drainer. (They reconnect either way over DIDComm, but this is the intended order.)
2. **`ReadWritePaths=/home/flaxscrip/.hearthold-<kb>-{mage,warden}`** — per-KB vault isolation under
   `ProtectHome=read-only`. This is the security property: a world-facing Mage can write **only its own data
   root** — not either Warden vault — and the HATPro custodian cannot touch the personal vault. Preserve it
   verbatim per KB; it is the containment boundary between the KBs on a shared host.

The four reconciled unit files are alongside this doc: `hearthold-{mages,hatpro}-{mage,warden}.service`.

## Build recipe — the portal assets (per-KB, `VITE_*` baked at build time)

The browser portal is built per-KB; the `VITE_*` values are compiled into the bundle, so each KB needs its
own build into its own `--outDir`. nginx serves those directories directly as document root (nothing is
moved after the build).

```sh
# City of Mages (mages.archon.social)
# SKIP the root build for a portal SPA on a live tree — the portal has NO workspace deps, and the root
# build regenerates packages/*/dist under every running Warden. Only the apps/kb-portal build below is needed.
cd apps/kb-portal
VITE_PORTAL_URL=https://mages.archon.social \
VITE_KB_ID=city-of-mages \
VITE_SIGNET_URL=https://wallet.archon.technology \
npm run build -- --outDir dist-mages

# HATPro (kb.hatpro.archon.technology)
# SKIP the root build for a portal SPA on a live tree — the portal has NO workspace deps, and the root
# build regenerates packages/*/dist under every running Warden. Only the apps/kb-portal build below is needed.
cd apps/kb-portal
VITE_PORTAL_URL=https://kb.hatpro.archon.technology \
VITE_KB_ID=hatpro-kb \
VITE_SIGNET_URL=https://wallet.archon.technology \
npm run build -- --outDir dist-hatpro
```

## Caveats — what this reconciliation does NOT yet make safe

- **The `dist-*` recipe reproduces `mages` but NOT `hatpro` — they were built at different commits** (verified
  2026-08-29, isolated-clone rebuild at `ae1b075` diffed against the backups). Build the portal in an isolated
  clone at a pinned commit and copy the output into place (never a root build on the live tree — the portal has
  no workspace deps; ~5 MB install, ~1 s). Results:
  - **`mages` is effectively reproducible** — the rebuilt CSS is **byte-identical** (same content hash) and the
    JS differs by 48 bytes (a transitive-dep patch, not a source change). The recipe is sound; the live `mages`
    dist is **not** irreplaceable.
  - **`hatpro` is a materially OLDER build** — its live CSS is *less than half* the current size (`+5737` B on
    rebuild) plus `~2.5 KB` of JS, and doesn't match `mages`'s live CSS either. So **regenerating `dist-hatpro`
    from the recipe would CHANGE it (silently upgrade the NIH-facing portal's UI) — that is a DEPLOY, not a
    rebuild.** "Just rebuild it" is the trap. The backup at
    `archon-ops:~/…/host-only-backup-20260829-031332/portal-builds/` is the ONLY copy of the current `hatpro`
    build and cannot be regenerated — keep it.
- **The `.env.*` files are host-only by design** (0600 secrets: `HEARTHOLD_PASSPHRASE`, `HEARTHOLD_WARDEN_DID`,
  registry, node URL, Ollama URL). They are intentionally **not** committed. A rebuild recreates them on the
  host; the unit files reference them via `EnvironmentFile=` and contain no inline secrets.
- **`INSTALL-hatpro.md` and `INSTALL-mages.md` are now both in the repo** (this branch). Two corrections were
  applied on commit rather than transcribing the stale host-only copies verbatim: the megaflax prereq (it is an
  always-on workstation, not a sleeping laptop — the stale claim had caused real faults to be dismissed), and
  the mages doc's stale "NOT PROVISIONED"/"BLOCKER" sections (the KB has been live since 2026-08-24; the checkout
  is no longer on the old branch), now moved to a dated **Historical record** section. The units
  `Documentation=`-reference both. Each carries a "Known defects" list surfaced during provisioning — see below.

## Backup

A full host-only backup (all eight unit files, both INSTALL docs, the `dist-*` trees copied `-a`, the
modified `package-lock.json`, and a git-status snapshot at `62bc19f`) is held at
`archon-ops:~/archon-ops/hearthold/host-only-backup-20260829-031332/`.
