# Runbook — governing the family agents (repoint + parent-signed allowances)

Moves the three family agents (**Sevenfold, Aegis, Hearthold**) from *ungoverned root* to the decided
topology (flaxscrip, 2026-08-28): **each is its OWN Sovereign, governed by the node sovereign as PARENT**
(see [`family-agent-sovereign-topology`] and `agentgate-allowance.md`). It closes two live symptoms on the
`b2b25fa` deploy at once:

1. every emissary's `sovereignDid` points at the **node** sovereign, not its own → Sevenfold's bind-by-DID
   guard excludes the agent's own signet as foreign;
2. every agent-signet is an **ungoverned root** self-approver (`controlAllowance.bound:false`) — the
   AgentGate.permit enforcement shipped but no allowance is provisioned, so the gate is open.

The two are **independent** and need NOT land together (Aegis retracted the earlier "together" note after
checking it, 2026-08-28): there are *already* two answers today — every warden names its own Sovereign, every
emissary names the node — so repointing an emissary strictly REDUCES the inconsistency, it does not create
one. Aegis also verified the only real risk of repointing alone — `ownerOf(a) = a.owner ?? config.sovereignDid`
silently reassigning *unowned* artefacts — is nil: sevenfold's vault holds 6 artefacts, **0 unowned**, so the
fallback moves nothing. So **Part A (repoint) is safe standalone and goes first — it unblocks Sevenfold's live
render immediately** — while **Part B (allowances)** waits on flaxscrip signing three rulesets + deciding scope.

## Identities (full DIDs, from Aegis's live probe)

| agent | its OWN Sovereign DID | warden today | emissary today |
|---|---|---|---|
| sevenfold | `did:cid:bagaaieradstvn46cks6fgjeilmajyaorsgt3pnscjyq7h2jvo5bvkcl23vqq` | ✓ own (per-agent var) | ✗ node (shared var) |
| hearthold | `did:cid:bagaaieral7gyx5p2nkkplnxe5vpinwgpgyzhgsb4ac24lm7vy33gyyx34jzq` | ✓ own (per-agent var) | ✗ node (shared var) |
| aegis | `did:cid:bagaaiera4jcssav3sn7f2owztjgyzynv3k25p23mvfyhybvmfyl3hkltc4nq` | ✓ own (per-agent var) | ✗ node (shared var) |

Parent (node sovereign, the human PIN gate at `:4361`): `did:cid:bagaaierayveej3vjjm4owqq2ialx7zew3lyhuqjph2mnydlbedh4sjij3ufa`.

**Note (Aegis):** the **wardens already name their own Sovereign** — each reads a per-agent var
(`AGENT_HH_SOVEREIGN_DID` / `AGENT_SEVEN_SOVEREIGN_DID` / `AGENT_AEGIS_SOVEREIGN_DID`). Only the **emissaries**
mis-point, because all three read ONE shared var `AGENT_REPORT_SOVEREIGN` (= node). So they *cannot* name
different Sovereigns as the compose stands — fixing it is a **compose change** (introduce per-agent emissary
vars, mirroring the wardens), not an env-value swap.

## Track A — repoint the emissaries (standalone; unblocks Sevenfold now)  ·  OWNER: Aegis (compose change)

Independent of the allowances — do it first. All three emissaries read one shared `AGENT_REPORT_SOVEREIGN`
(= node); introduce a **per-agent** emissary var (mirroring the wardens' `AGENT_*_SOVEREIGN_DID`) so each
`*-agent-emissary` service's `HEARTHOLD_SOVEREIGN_DID` resolves to its OWN Sovereign (table above). Redeploy
the emissaries. Safe alone (wardens already correct; 0 unowned artefacts → the `ownerOf` fallback moves
nothing). Result: each emissary reports its own `sovereignDid`, Sevenfold's bind-by-DID guard matches its own
signet, and the live Trinity renders correctly — as **root** still (governance comes in Part B), but no longer
foreign-excluded. This is a low-risk consistency repair; still flaxscrip's nod, but it needs nothing signed.

---

# Part B — the allowances (the authority step)

## DECISION FOR FLAXSCRIP — the control-act authority table (gates everything)

For each agent, what may it **self-approve** (`control.selfApprove`)? Every control act *omitted* escalates
to the node sovereign's Signet (proof-of-human). Acts: `grant-capability`, `mint-root-capability`,
`authorize-capability`, `revoke-*`, … each with an optional `resourcePrefix`.

**What actually closes the gate:** setting `HEARTHOLD_PARENT_DID` makes the signet a **child**
(`isChild:true`) — a child with no self-approvable acts escalates *everything* to the parent
(deny-by-default). The gate closes from having a parent, not from the allowance contents. So the allowance
`selfApprove` is purely "how much may it self-approve *without* asking the parent."

**Recommended conservative start (secure-by-default; widen deliberately per demonstrated need):**
- **All three: empty `selfApprove` initially.** The signet becomes `gateMode:'agent'`, a CHILD, with
  `controlAllowance.bound:false` (empty ⇒ not bound) — banner "CHILD — DENY-BY-DEFAULT: self-approves nothing
  above standing, every act escalates to the parent." This CLOSES the open gate with the least authority.
  (Note: `bound:false` here is the *governed* state, distinct from a ROOT which reports **no** `controlAllowance`
  at all.)
- Then widen one agent at a time as a real need appears (e.g. grant Aegis `grant-capability` within its own
  infra resource prefix → `bound:true`), each widening a fresh parent-signed supersession.

Confirm the scope per agent before Step B1 — this is the one governance call; the rest is mechanical.

## Step B1 — sign + anchor an allowance per agent  ·  OWNER: flaxscrip (node-sovereign wallet)

For each agent, with the **node sovereign** wallet (the parent). Reference: `scripts/e2e-agent-allowance.ts`
lines 72–89.

```ts
const allowanceCaps: ControlAllowance = { selfApprove: [ /* the DECIDED acts for this agent */ ] };
const rulesetBody: Ruleset = {
  actor: '<AGENT own Sovereign DID>',   // e.g. …jvo5bvkcl23vqq for sevenfold
  actorKind: 'sovereign',
  version: 1, previous: null,
  capabilities: { control: allowanceCaps },
  ceiling: 0, status: 'active',
};
const signed = await signRuleset(nodeSovereign, rulesetBody);      // PARENT signs — a self-signed one is refused
const allowanceAsset = await nodeSovereign.keymaster.createAsset([signed], { registry });
// → allowanceAsset (a did:cid) becomes HEARTHOLD_CONTROL_ALLOWANCE_ASSET for that agent
```

Output: **3 allowance asset DIDs** (one per agent). I can turn this into a turnkey
`scripts/provision-agent-allowance.ts` you run against the node-sovereign wallet — say the word.

## Step B2 — wire the allowances onto the signets  ·  OWNER: Aegis (deploy config)

Per agent's `*-agent-signet` service, **add** (these are not currently on the signets):
- `HEARTHOLD_PARENT_DID = did:cid:…lbedh4sjij3ufa` (node). Note it currently lives in the
  `x-agent-warden-env` anchor and reaches only the wardens — it must be **added** to the signet services.
- `HEARTHOLD_CONTROL_ALLOWANCE_ASSET = <that agent's allowance DID from Step B1>`.

The signet takes **no** `HEARTHOLD_SOVEREIGN_DID` — it IS the Sovereign via its wallet identity. Wardens need
nothing here (already own-Sovereign). Already in place from #38: `HEARTHOLD_GATE_MODE=agent` and
`HEARTHOLD_CONTROL_HOST=0.0.0.0` on the signets. Redeploy the signets.

## Verify

**After Track A (repoint):**
- Each **emissary** status → `sovereignDid` = its OWN Sovereign (no longer the node).
- **Sevenfold's Table** → composes (signet identity == `sovereignDid`); renders "AI Sovereign ·
  proof-of-agent · **root**" (still ungoverned — Part B not done), no longer foreign-excluded, no `didcommOnly`.

**After Part B (allowances):**
- Each **agent-signet** `GET /api/status` → `gateMode:'agent'`, `controlAllowance` **present** with
  `parentDid` = node. `bound:false` for the empty-start (CHILD, deny-by-default); `bound:true` + `selfApprove`
  once acts are granted. Either way, no longer a ROOT (which reports no `controlAllowance`).
- **Sevenfold's Table** → flips ROOT → **governed** (child); "deny-by-default" for empty, "bound" once widened.
- `npm run e2e:agent-allowance` still green — the model-level regression guard for within/above/deny/forged.

## Rollback

Aegis's per-deploy rollback tag (`hearthold:*-rb-<sha>-pre`). Both tracks are additive config (+ new signed
assets for Part B); reverting the env + redeploying returns to the prior posture, which the honest banner
still describes truthfully. Track A and Part B roll back independently.
