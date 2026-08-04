# Aegis environment hygiene — proposed structure

**Author:** Aegis · **Date:** 2026-07-31 · **Status:** proposal (safe cleanup done; disruptive steps await go-ahead)

## TL;DR — how many environments do we need?
**Per box: 2 standing + 1 optional throwaway.**
1. **`node`** — the isolated Archon node. The *real* identity universe (Sovereign `…ij3ufa`, Warden, Emissaries)
   **and the AI-family agents folded in under that Sovereign.** This is the one that matters.
2. **`hearthold-dev`** — Hearthold's custodian dev stack (Warden/Signet/Emissary code), a separate universe on
   purpose so Hearthold iterates without touching the live node.
3. **`scratch`** *(optional)* — a throwaway isolated env for experiments, wiped freely, so a test never again spawns
   a stray parallel universe (which is how the demo family happened).

**Retire:** the demo family as a *separate* universe (fold it into `node`); the empty `aegis-emissary` root.

## Root cause of the identity confusion
We ran **three parallel identity universes** — `~/aegis-sovereign-hs` (node), `~/aegis-family` (demo), `~/hearthold`
(Hearthold dev) — each with its *own* `sovereign` and `warden` wallet. Nothing tied a wallet to an environment, and
the names didn't line up (`aegis` project · `aegis_internal` net · `aegis-sovereign-hs` data — three different slugs
for one node). So "which Sovereign am I, in which registry?" had no single answer, and a card went to the wrong one.

## Three principles that kill it

**1 — One slug per environment, carried everywhere.** An environment named `node` owns compose project
`aegis-node`, network `aegis-node_internal`, data root `…/node/data`, and MCP instance `node`. One word, five places.

| env | compose project | network | data root | MCP instance |
|---|---|---|---|---|
| `node` | `aegis-node` (+ `aegis-node-control`) | `aegis-node_internal` | `~/aegis-env/node/data` | `node-*` |
| `hearthold-dev` | `hearthold-dev` | `hearthold-dev_internal` | `~/aegis-env/hearthold-dev/data` | `hh-dev-*` |
| `scratch` | `aegis-scratch` | `aegis-scratch_internal` | `~/aegis-env/scratch/data` | — |

**2 — One identity universe per environment, in one clearly-foldered store.** Never two `sovereign`s in scope.
Roles are unambiguous folders; each folder is exactly one DID:
```
data/identities/
  sovereign/                 # THE Sovereign for this env  (node → flaxscrip / …ij3ufa)
  warden/                    # the Warden
  emissaries/<name>/         # one folder per Emissary / data path  (mailbox, image, …)
  agents/<name>/             # AI-family members, each parented under sovereign  (aegis, sevenfold, hearthold)
```

**3 — An `ENVIRONMENT.md` manifest per environment = the single source of truth.** You read it; you never guess.
It carries: slug · compose project · network · **isolation-safe gatekeeper URL** · registry · the **identity roster
(role → DID → wallet path)** · passphrase source · and the **MCP binding block** (ready for the agent-sovereign MCP).
This is the anti-confusion device — a human or an MCP resolves identity from the manifest, never by convention.

## Target directory layout
Runtime (data + config) is separated from source repos and consolidated under one parent:
```
~/aegis-env/                       # ALL Aegis-managed runtime environments (never source)
  node/
    ENVIRONMENT.md                 # the manifest
    env/                           # .env, docker-compose overrides, control env
    data/
      identities/{sovereign,warden,emissaries/*,agents/*}
      archon/                      # ipfs · mongo · redis · lightning state
  hearthold-dev/
    ENVIRONMENT.md   env/   data/{identities/*,archon/*}
  scratch/
    ENVIRONMENT.md   env/   data/
  _archive/                        # retired roots, read-only until confirmed dead
    aegis-family/   aegis-emissary/

# Source repos stay put and are never mixed with runtime:
~/isolation/aegis      (Aegis)      ~/hearthold, ~/hearthold_mage, ~/hearthold-dep (Hearthold)      ~/archon (upstream)
```

## The AI-family folds into `node` (the reconciliation)
`flaxscrip = node Sovereign (…ij3ufa) = parent/governor` (the Table login, the Signet that decides escalations).
`Aegis · Sevenfold · Hearthold = agents/` under it, each parent-signed. The demo family (`~/aegis-family`) becomes
`~/aegis-env/_archive/aegis-family` once the three agents are re-provisioned under `…ij3ufa`. One family, one node,
one Sovereign — and the agent-sovereign MCP binds one instance per `agents/<name>`, config drawn from the manifest.

## Migration — status (executed 2026-07-31)
- **Phase 0 — DONE.** Killed the stray hung keymaster (`zealous_saha`) that was holding `~/aegis-family`.
- **Phase 1 — DONE.** `~/aegis-env/` created; `node/ENVIRONMENT.md` + `hearthold-dev/ENVIRONMENT.md` written with
  verified rosters; empty `~/aegis-emissary` → `_archive/`.
- **Family fold — DONE (reproduce, not migrate).** Test data isn't precious, so instead of migrating the demo
  family we **recreated** it: `deploy/family/provision-node-family.sh` provisioned Aegis/Sevenfold/Hearthold FRESH
  under the real node Sovereign `…ij3ufa`, each with a parent-signed ruleset, in `node/data/identities/agents/`.
  The fake `…av2bq` parent and duplicate id-names are gone; `~/aegis-family` archived. `aegis-wallet` now points at
  the node-env agents (Sovereign/Warden are node-managed, refused by the CLI).
- **Phase 2 — at the next redeploy.** Align slugs (`aegis` → `aegis-node`, `aegis_internal` → `aegis-node_internal`)
  and consolidate the node substrate/Sovereign data from `~/aegis-sovereign-hs/data` into `~/aegis-env/node/data`.
  Only takes effect on recreate — folded into a normal restart, not a live rip-up.
- **Phase 4 — with the MCP.** One MCP instance per bound agent, every field read from `node/ENVIRONMENT.md`.

**Follow-up (not done):** the legacy `deploy/family/*.ts` harnesses still spin up their own throwaway demo family
under the old paths — they're superseded by the provisioner + node env. Update or retire them to bind the node
Sovereign as parent when we next touch path-B. Live `node`/`hearthold-dev` **substrate** data stays put until the
Phase-2 redeploy (we don't move a bind-mount out from under a running container).
