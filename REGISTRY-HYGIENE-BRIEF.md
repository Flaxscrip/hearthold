# Registry Hygiene — Build Brief (stop polluting mainnet with test agents)

**Date:** 2026-07-13 · prepared in Cowork by GenitriX, at flaxscrip's direction
**Incident:** ~800 net-new agent DIDs on the public hyperswarm registry in two weeks (540 → 1380), ~99% traced by macterra to `flaxscrip:flaxlap` / Hearthold. Attribution evidence: `did-creation-source.md` (this repo). Burst content: `actor:"hearthold-kb"`, `kb-read-*`/`kb-write-*` groups, `kb-web` — KB provisioning and e2e regression runs. Root cause: **isolated data roots are not isolated registries** — every test `createId` registered on the node's default registry (hyperswarm) and gossiped to mainnet forever.
**The fix, per macterra:** use the **`local` registry** for testing. Verified in `@didcid/gatekeeper` source: `supportedRegistries` defaults to `['local','hyperswarm']`; `queueOperation` returns early for `local` ("Don't distribute local DIDs"); `exportBatch` filters local DIDs from every gossip batch; and a local-controlled DID is *refused* if it tries to create a non-local child. Local DIDs resolve on their node only and die with the node's DB.

---

## Work items

### 1. Default all test/demo identity creation to `registry: 'local'`

- `core/config.ts` already reads `HEARTHOLD_REGISTRY ?? DEFAULT_REGISTRY` and `core/identity.ts` passes `{ registry: config.registry }` to `createId` — so the spine is one env var. Set `HEARTHOLD_REGISTRY=local` in **every** `e2e:*`, `demo:*`, `smoke:*`, `proto:*`, and `roleplay:*` npm script (a shared env prelude or a tiny `scripts/test-env.mjs` wrapper beats editing 20 script lines).
- **Flip the default the safe way:** consider `DEFAULT_REGISTRY = 'local'` in config, with hyperswarm as the *explicit* choice in production deployment env (`.env` on flaxlap, the portal, kb service units). Deny-by-default for registry egress — a DID should be born local and *promoted* deliberately. If that's too big a swing for one pass, at minimum make the e2e harness refuse to run when `HEARTHOLD_REGISTRY` is unset (fail loud, not fail open).

### 2. Close the asset-path gap (the fix is incomplete without this)

`Keymaster.createAsset` (and everything built on it: credentials, schemas, groups, vaults, challenges, responses, polls, dmail) uses the **Keymaster instance's `defaultRegistry`**, not Hearthold's per-call `createId` option. Audit how our `KeymasterHandle` constructs the client and set the instance default registry from `HEARTHOLD_REGISTRY` at construction (constructor option or setter — check `@didcid/keymaster` for the supported knob). Also check `ephemeralRegistry` (used for notices; defaults to `'hyperswarm'`) — test notices should be local too.

### 3. CI guard — make the regression impossible to reintroduce silently

New e2e (`e2e:registry-hygiene`), run first in the aggregate: in test mode, create one identity, one credential, one schema, one group, one vault item; resolve each; **assert `didDocumentRegistration.registry === 'local'` for every one.** If any resolves as hyperswarm, fail with the DID printed. This is the test that would have caught the incident on day one.

### 4. Deliberate exceptions, marked as such

The genuinely-live tests keep hyperswarm **by explicit opt-in, named in the script**: `interop:registry` (cross-node resolution — local can't resolve remotely, by design), and anything exercising the public portal end-to-end. Convention: those scripts set `HEARTHOLD_REGISTRY=hyperswarm` inline with a `# LIVE: writes mainnet` comment. Everything else is local, no exceptions.

### 5. Cleanup of the existing ~800 (best-effort, coordinate with macterra)

They are permanent agent registrations (agents have no `validUntil` — verified in `createIdOperation`: the registration is `{version, type:'agent', registry}` only; revocation appends a tombstone but nothing leaves the gossip log). So: enumerate the fixtures under the known controller DID (`did:cid:bagaaierar4tt…zd4ja`, per the traffic analysis) and `revoke_did` what we still control — it doesn't shrink the log, but it marks them dead and lets any future GC or filter treat them as prunable. Ask macterra whether the mediator/registry can (or should) grow pruning for revoked agents; file whatever he decides as the disposal path.

### 6. One-paragraph postmortem → `docs/registry-hygiene.md`

Incident, root cause, fix, guard — in the honest style of the house (the harness folks file defects at win-prominence; so do we). Include the design lesson worth keeping: **a DID registration is itself a disclosure** (existence + activity patterns; the network read our dev schedule), so registry egress deserves the same deny-by-default the data plane already has. "Born local, promoted deliberately."

## Related (context, not this brief's work)

- `docs/archon-issue-pairwise-dids.md` gains ask #4 (ephemeral agents: `validUntil` on `type:'agent'` + GC, mirroring assets) and a sharpened ask #2 (what `local` can't do: a relationship DID resolvable by exactly one *remote* counterparty). Attach `did-creation-source.md` as evidence when posted — flaxscrip reviews before posting.
- The harness seat's reference vault (HARNESS-SEAT-BRIEF D4) must seed with `HEARTHOLD_REGISTRY=local` — add it to the seed script's env before first run, or the first spar pollutes mainnet all over again, ceremonially.

## Done means

- [ ] All test/demo scripts run `registry: 'local'` end to end (identities AND assets/credentials/schemas/groups)
- [ ] `e2e:registry-hygiene` green, wired first into `npm run e2e`
- [ ] Live-by-choice scripts marked `# LIVE: writes mainnet`
- [ ] Harness seed script covered (D4 env)
- [ ] Existing fixtures revoked (list attached), disposal question filed with macterra
- [ ] `docs/registry-hygiene.md` postmortem committed
